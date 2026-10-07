// A stand-in for a SoundTouch 20, for trying the wizard without hardware and
// for the tests. It answers on the speaker's real ports, so it gets a
// loopback address to itself:
//
//   node test/fake-speaker.mjs            # a speaker at 127.0.0.2
//   node test/fake-speaker.mjs 127.0.0.3 "Kitchen"
//
// then add 127.0.0.2 in the wizard. Type 1 to 6 and Enter to press a button.
//
// It behaves the way the real one is documented to: presets are kept and
// announced, a preset press is announced on the websocket, a UPnP play or a
// custom-station preset fetches the stream, and the service console on port
// 17000 changes which servers it asks and restarts it.
import { createHash } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { createServer as createTcp } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FACTORY } from '../src/migrate.mjs';
import { attr, element, text } from '../src/xml.mjs';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function createSpeaker({ ip = '127.0.0.2', name = 'Living Room', type = 'SoundTouch 20', id = 'A0B1C2D3E4F5', restartMs = 2_000, quiet = false } = {}) {
  const log = (...args) => { if (!quiet) console.log(`[${name}]`, ...args); };
  const speaker = {
    ip, id, name, type,
    account: '',
    config: { ...FACTORY },
    pending: {}, // console writes that have not been committed
    presets: {},
    playing: null,
    fetched: [], // every stream address it has started
    sockets: new Set(),
    servers: [],
    up: true,
  };

  const item = (entry) => `<ContentItem source="${entry.source}"${entry.type ? ` type="${entry.type}"` : ''} location="${entry.location.replace(/&/g, '&amp;')}" sourceAccount="${entry.sourceAccount || ''}" isPresetable="true"><itemName>${entry.name}</itemName></ContentItem>`;
  const xml = (res, body, status = 200) => res.writeHead(status, { 'Content-Type': 'text/xml' }).end(`<?xml version="1.0" encoding="UTF-8" ?>${body}`);

  function announce(body) {
    const payload = Buffer.from(`<updates deviceID="${id}">${body}</updates>`);
    const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    for (const socket of speaker.sockets) socket.write(Buffer.concat([head, payload]));
  }

  // Opens a stream and reads a little of it, as a speaker starting to play.
  async function fetchStream(url, label) {
    speaker.fetched.push(url);
    try {
      const abort = new AbortController();
      const response = await fetch(url, { signal: abort.signal });
      const reader = response.body.getReader();
      let bytes = 0;
      while (bytes < 16_000) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      abort.abort();
      speaker.playing = response.ok && bytes > 0 ? label : null;
      log(response.ok ? `playing ${label} (${response.headers.get('content-type')}, ${bytes} bytes read)` : `stream refused: HTTP ${response.status}`);
    } catch (error) {
      speaker.playing = null;
      log(`stream failed: ${error.message}`);
    }
  }

  // A custom-station preset: ask the registry where the adapter is, ask the
  // adapter for the stream, then play it.
  async function playRadio(entry) {
    const registry = await (await fetch(speaker.config.bmxRegistryUrl)).json();
    const adapter = registry.bmx_services.find((service) => service.id.name === 'LOCAL_INTERNET_RADIO');
    const address = /^https?:/.test(entry.location) ? entry.location : `${adapter.baseUrl}${entry.location}`;
    const station = await (await fetch(address)).json();
    await fetchStream(station.audio.streamUrl, station.name);
  }

  async function select(entry) {
    if (entry.source === 'LOCAL_INTERNET_RADIO') await playRadio(entry).catch((error) => log(`radio failed: ${error.message}`));
    else if (entry.source === 'UPNP') await fetchStream(entry.location, entry.name);
  }

  // What happens when a preset button is pressed on the speaker.
  speaker.press = async (slot) => {
    const entry = speaker.presets[slot];
    if (!entry) return log(`button ${slot} is empty`);
    log(`button ${slot} pressed`);
    announce(`<nowSelectionUpdated><preset id="${slot}">${item(entry)}</preset></nowSelectionUpdated>`);
    return select(entry);
  };

  async function boot() {
    speaker.up = true;
    log(`started, asking ${speaker.config.margeServerUrl}`);
    if (speaker.config.margeServerUrl.startsWith('https://')) return; // Bose is gone
    const marge = speaker.config.margeServerUrl;
    try {
      await fetch(`${marge}/streaming/support/power_on`, { method: 'POST', body: `<device-data><device id="${id}"></device></device-data>` });
      await fetch(speaker.config.bmxRegistryUrl);
      if (speaker.account) {
        const full = await (await fetch(`${marge}/streaming/account/${speaker.account}/full`)).text();
        log(`account synced (${(full.match(/<preset /g) || []).length} presets)`);
      }
    } catch (error) {
      log(`could not reach its servers: ${error.message}`);
    }
  }

  function reboot() {
    speaker.up = false;
    for (const socket of speaker.sockets) socket.destroy();
    setTimeout(boot, restartMs);
  }

  async function body(req) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw;
  }

  const api = createHttp(async (req, res) => {
    if (!speaker.up) return res.writeHead(400).end();
    const path = req.url.split('?')[0];
    const sent = req.method === 'POST' ? await body(req) : '';
    if (path === '/info') {
      return xml(res, `<info deviceID="${id}"><name>${name}</name><type>${type}</type><margeAccountUUID>${speaker.account}</margeAccountUUID><components><component><componentCategory>SCM</componentCategory><softwareVersion>27.0.6.46330.5043500 epdbuild.trunk.hepdswbld04.2022-08-04T11:20:29</softwareVersion><serialNumber>P1234567890123456789012</serialNumber></component></components><margeURL>${speaker.config.margeServerUrl}</margeURL><networkInfo type="SCM"><macAddress>${id}</macAddress><ipAddress>${ip}</ipAddress></networkInfo></info>`);
    }
    if (path === '/presets') {
      return xml(res, `<presets>${Object.entries(speaker.presets).map(([slot, entry]) => `<preset id="${slot}">${item(entry)}</preset>`).join('')}</presets>`);
    }
    if (path === '/sources') {
      const radio = speaker.config.bmxRegistryUrl.startsWith('http://') && speaker.account ? '<sourceItem source="LOCAL_INTERNET_RADIO" status="READY" isLocal="false" multiroomallowed="true" />' : '';
      return xml(res, `<sources deviceID="${id}"><sourceItem source="AUX" sourceAccount="AUX" status="READY" isLocal="true">AUX IN</sourceItem><sourceItem source="UPNP" sourceAccount="UPnPUserName" status="UNAVAILABLE">UPnPUserName</sourceItem><sourceItem source="BLUETOOTH" status="UNAVAILABLE" isLocal="true" />${radio}</sources>`);
    }
    if (path === '/now_playing') {
      return xml(res, speaker.playing
        ? `<nowPlaying deviceID="${id}" source="UPNP"><stationName>${speaker.playing}</stationName><playStatus>PLAY_STATE</playStatus></nowPlaying>`
        : `<nowPlaying deviceID="${id}" source="STANDBY"><ContentItem source="STANDBY" isPresetable="false" /></nowPlaying>`);
    }
    if (path === '/storePreset' || path === '/select') {
      const node = element(sent, 'ContentItem');
      if (!node) return xml(res, '<errors><error value="1019" name="CLIENT_XML_ERROR">bad request</error></errors>', 400);
      const entry = { source: node.attrs.source, type: node.attrs.type, location: node.attrs.location, sourceAccount: node.attrs.sourceAccount, name: text(node.inner, 'itemName') };
      if (path === '/select') {
        select(entry);
        return xml(res, '<status>/select</status>');
      }
      const slot = Number(attr(sent, 'preset', 'id'));
      speaker.presets[slot] = entry;
      announce('<presetsUpdated/>');
      // A speaker that has been pointed somewhere tells that server.
      if (!speaker.config.margeServerUrl.startsWith('https://') && speaker.account) {
        fetch(`${speaker.config.margeServerUrl}/streaming/account/${speaker.account}/device/${id}/preset/${slot}`, {
          method: 'PUT',
          body: `<preset buttonNumber="${slot}"><sourceid>10003</sourceid><name>${entry.name}</name><location>${entry.location.replace(/&/g, '&amp;')}</location><contentItemType>stationurl</contentItemType></preset>`,
        }).catch(() => {});
      }
      return xml(res, '<presets/>');
    }
    if (path === '/setMargeAccount') {
      speaker.account = text(sent, 'accountId');
      fetch(`${speaker.config.margeServerUrl}/streaming/account/${speaker.account}/device/`, { method: 'POST', body: `<device deviceid="${id}"><name>${name}</name><macaddress>${id}</macaddress></device>` }).catch(() => {});
      return xml(res, '<status>/setMargeAccount</status>');
    }
    if (path === '/key') {
      const slot = /^PRESET_([1-6])$/.exec(text(sent, 'key'));
      if (slot && /state="release"/.test(sent)) speaker.press(Number(slot[1]));
      return xml(res, '<status>/key</status>');
    }
    return xml(res, '<errors><error value="1005" name="UNKNOWN_URL">unknown</error></errors>', 404);
  });

  // The notification websocket: just enough of the protocol to send text.
  const notifications = createHttp((req, res) => res.writeHead(426).end());
  notifications.on('upgrade', (req, socket) => {
    if (!speaker.up) return socket.destroy();
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_MAGIC).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: gabbo\r\n\r\n`);
    speaker.sockets.add(socket);
    socket.on('data', (frame) => { if ((frame[0] & 0x0f) === 8) socket.end(); });
    socket.on('close', () => speaker.sockets.delete(socket));
    socket.on('error', () => speaker.sockets.delete(socket));
    return undefined;
  });

  // The UPnP renderer.
  const renderer = createHttp(async (req, res) => {
    if (req.method === 'GET') {
      return res.writeHead(200, { 'Content-Type': 'text/xml' }).end('<root><device><serviceList><service><serviceId>urn:upnp-org:serviceId:AVTransport</serviceId><controlURL>/AVTransport/Control</controlURL></service></serviceList></device></root>');
    }
    const sent = await body(req);
    const action = /#(\w+)"?$/.exec(req.headers.soapaction || '')?.[1];
    if (action === 'SetAVTransportURI') {
      speaker.uri = text(sent, 'CurrentURI');
      speaker.title = /dc:title&gt;([^&]*)/.exec(sent)?.[1] || 'a stream';
      // The real renderer only takes plain http.
      if (!speaker.uri.startsWith('http://')) speaker.uri = null;
    }
    if (action === 'Play') {
      if (!speaker.uri) {
        return res.writeHead(500, { 'Content-Type': 'text/xml' }).end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>402</errorCode><errorDescription>No URI supplied</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
      }
      fetchStream(speaker.uri, speaker.title);
    }
    if (action === 'Stop') speaker.playing = null;
    return res.writeHead(200, { 'Content-Type': 'text/xml' }).end(`<s:Envelope><s:Body><u:${action}Response/></s:Body></s:Envelope>`);
  });

  // The service console.
  const service = createTcp((socket) => {
    socket.setEncoding('utf8');
    socket.write('->');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        const words = line.split(/\s+/);
        if (line.startsWith('sys configuration') && words.length === 4) {
          speaker.pending[words[2]] = words[3];
          socket.write('OK\r\n->');
        } else if (line.startsWith('envswitch boseurls set') && words.length === 5) {
          // The commit: what was written before this line is kept.
          Object.assign(speaker.config, speaker.pending, { margeServerUrl: words[3], swUpdateUrl: words[4] });
          speaker.pending = {};
          socket.write(`Setting Bose Server URLs to ${words[3]} and ${words[4]}\r\n->`);
        } else if (line === 'getpdo CurrentSystemConfiguration') {
          const shown = { ...speaker.config, ...speaker.pending };
          socket.write(`${Object.entries(shown).map(([key, value]) => `${key} {\r\n  text: "${value}"\r\n}`).join('\r\n')}\r\n\r\n->OK\r\n->`);
        } else if (line === 'sys reboot') {
          socket.write('Rebooting system\r\n');
          speaker.pending = {};
          socket.end();
          reboot();
        } else if (line) {
          socket.write('Command not found\r\n->');
        }
      }
    });
    socket.on('error', () => {});
  });

  const open = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, ip, resolve);
    speaker.servers.push(server);
  });

  speaker.start = async () => {
    await Promise.all([open(api, 8090), open(notifications, 8080), open(renderer, 8091), open(service, 17000)]);
    log(`a ${type} is answering at ${ip}`);
    return speaker;
  };
  speaker.stop = () => {
    for (const socket of speaker.sockets) socket.destroy();
    for (const server of speaker.servers) {
      server.closeAllConnections?.();
      server.close();
    }
  };
  return speaker;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const speaker = await createSpeaker({ ip: process.argv[2] || '127.0.0.2', name: process.argv[3] || 'Living Room', id: process.argv[4] || 'A0B1C2D3E4F5', type: process.argv[5] || 'SoundTouch 20' }).start();
  console.log('Type 1 to 6 and Enter to press a preset button.');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const slot = Number(line.trim());
    if (slot >= 1 && slot <= 6) speaker.press(slot);
  });
}
