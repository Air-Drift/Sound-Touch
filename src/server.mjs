// One HTTP server does three jobs: the setup pages and their API for people,
// the audio for speakers, and (for speakers that have been pointed here) the
// handful of answers Bose's servers used to give.
import { randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize } from 'node:path';
import * as cloud from './bose/cloud.mjs';
import { config } from './config.mjs';
import * as control from './control.mjs';
import { discover, lanAddresses } from './discovery.mjs';
import { check } from './health.mjs';
import * as proxy from './proxy.mjs';
import * as speakerApi from './speaker.mjs';
import * as stations from './stations.mjs';
import { SLOTS, preset, publicUrl, save, speaker, speakers, state } from './store.mjs';

export const instance = randomUUID();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65_536) throw new Problem(413, 'That request is too large.');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Problem(400, 'That request was not valid JSON.');
  }
}

const hostOf = (value) => String(value || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

// The setup pages have no login, so they refuse to be driven from elsewhere:
// a page on another site cannot post to them, and a public name that has been
// re-pointed at this address (DNS rebinding) is turned away.
function guard(req) {
  const host = hostOf(req.headers.host);
  const known = isIP(host) || host === 'localhost' || !host.includes('.')
    || /\.(local|lan|home|internal|home\.arpa)$/.test(host)
    || host === hostOf(new URL(publicUrl() || 'http://localhost').host)
    || config.allowedHosts.includes(host);
  if (!known) throw new Problem(403, `These pages are not served under the name ${host}. Add it to ALLOWED_HOSTS if it is yours.`);
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && hostOf(new URL(origin).host) !== host) throw new Problem(403, 'That request came from another site.');
}

function need(id) {
  const found = speaker(id);
  if (!found) throw new Problem(404, 'There is no speaker with that id.');
  return found;
}

function stateView() {
  return {
    version: config.version,
    setupComplete: state.setupComplete,
    publicUrl: publicUrl(),
    publicUrlPinned: Boolean(config.publicUrl),
    port: config.port,
    addresses: lanAddresses(),
    stations: stations.status(),
    ffmpeg: Boolean(proxy.ffmpeg()),
    speakers: speakers().map(control.view),
  };
}

async function reachable(url) {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(4_000) });
    const answer = await response.json();
    return answer.instance === instance ? { reachable: true } : { reachable: false, detail: 'something else answered there' };
  } catch (error) {
    return { reachable: false, detail: error.cause?.code || error.message };
  }
}

async function api(req, res, url) {
  guard(req);
  const [, , first, second, third, fourth] = url.pathname.split('/');
  const route = `${req.method} ${first}${second ? '/:' : ''}${third ? `/${third}` : ''}`;
  const top = `${req.method} ${first}${second ? `/${second}` : ''}`;

  if (top === 'GET state') return json(res, 200, stateView());
  if (top === 'GET health') return json(res, 200, await check(instance));

  if (top === 'POST settings') {
    if (config.publicUrl) throw new Problem(409, 'The address is fixed by PUBLIC_URL.');
    const input = await body(req);
    let parsed;
    try {
      parsed = new URL(String(input.publicUrl || '').trim());
    } catch {
      throw new Problem(400, 'Enter an address like http://192.168.1.20:8686.');
    }
    if (parsed.protocol !== 'http:') throw new Problem(400, 'The address has to start with http://. Speakers cannot use https here.');
    if (/^(localhost|127\.|\[?::1)/.test(parsed.hostname)) throw new Problem(400, 'A speaker cannot reach "localhost". Use this machine\'s address on your network.');
    state.publicUrl = parsed.origin;
    save();
    return json(res, 200, { publicUrl: state.publicUrl, ...(await reachable(state.publicUrl)) });
  }

  if (top === 'POST discover') return json(res, 200, { speakers: await discover() });

  if (top === 'POST setup/complete') {
    state.setupComplete = true;
    save();
    return json(res, 200, { ok: true });
  }

  if (top === 'GET stations') return json(res, 200, stations.search(Object.fromEntries(url.searchParams)));
  if (top === 'GET stations/facets') return json(res, 200, stations.facets());
  if (top === 'POST stations/sync') {
    const result = await stations.sync();
    control.refreshStations();
    return json(res, 200, result);
  }

  if (top === 'POST speakers') {
    const { ip, country } = await body(req);
    const address = String(ip || '').trim();
    if (!isIP(address) && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(address)) throw new Problem(400, 'Enter the speaker\'s address, like 192.168.1.50.');
    let details;
    try {
      details = await speakerApi.info(address);
    } catch (error) {
      throw new Problem(502, `No SoundTouch speaker answered at ${address} (${error.cause?.code || error.message}).`);
    }
    const known = speaker(details.id);
    state.speakers[details.id] = {
      mode: 'listener',
      country: String(country || '').slice(0, 2).toUpperCase(),
      presets: control.defaults(String(country || '')),
      ...known,
      id: details.id, name: details.name, type: details.type, firmware: details.firmware, ip: address,
    };
    save();
    await control.adopt(state.speakers[details.id]);
    return json(res, 200, control.view(state.speakers[details.id]));
  }

  if (first !== 'speakers' || !second) throw new Problem(404, 'No such thing.');
  const target = need(second);

  if (route === 'DELETE speakers/:') {
    control.forget(target);
    delete state.speakers[target.id];
    save();
    return json(res, 200, { ok: true });
  }

  if (route === 'PUT speakers/:') {
    const input = await body(req);
    if (input.mode) {
      if (!['listener', 'native'].includes(input.mode)) throw new Problem(400, 'The mode is "listener" or "native".');
      target.mode = input.mode;
    }
    save();
    return json(res, 200, control.view(target));
  }

  if (route === 'PUT speakers/:/presets') {
    const slot = Number(fourth);
    if (!SLOTS.includes(slot)) throw new Problem(400, 'Buttons are numbered 1 to 6.');
    const input = await body(req);
    let chosen = null;
    if (input.stationId) {
      const found = stations.byId(String(input.stationId));
      if (!found) throw new Problem(404, 'That station is no longer in the list.');
      chosen = control.snapshot(found);
    } else if (input.custom) {
      const name = String(input.custom.name || '').trim().slice(0, 90);
      let address;
      try {
        address = new URL(String(input.custom.url || '').trim());
      } catch {
        throw new Problem(400, 'That stream address is not a valid URL.');
      }
      if (!name || !/^https?:$/.test(address.protocol)) throw new Problem(400, 'Give the stream a name and an http or https address.');
      chosen = { id: `custom-${randomUUID()}`, name, url: address.href, custom: true };
    } else if (!input.clear) {
      throw new Problem(400, 'Say which station to put on the button.');
    }
    target.presets[slot - 1] = chosen;
    save();
    const note = await control.slotChanged(target, slot);
    return json(res, 200, { message: chosen ? `Button ${slot} is now ${chosen.name}${note}` : `Button ${slot} is empty${note}` });
  }

  if (route === 'POST speakers/:/copy') {
    for (const other of speakers()) if (other.id !== target.id) other.presets = structuredClone(target.presets);
    save();
    return json(res, 200, { ok: true });
  }

  if (route === 'POST speakers/:/apply') return json(res, 200, await control.apply(target));

  if (route === 'POST speakers/:/play') {
    const slot = Number(fourth);
    if (!preset(target.id, slot)) throw new Problem(400, 'There is nothing on that button.');
    try {
      await control.play(target, slot);
    } catch (error) {
      throw new Problem(502, `${target.name} did not start playing: ${error.message}`);
    }
    return json(res, 200, { message: `Playing ${preset(target.id, slot).name} on ${target.name}` });
  }

  throw new Problem(404, 'No such thing.');
}

function file(req, res, url) {
  const wanted = url.pathname === '/' ? '/index.html' : url.pathname;
  const path = normalize(join(config.webDir, wanted));
  if (!path.startsWith(config.webDir)) throw new Problem(404, 'Not found');
  let size;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    throw new Problem(404, 'Not found');
  }
  const type = TYPES[extname(path)] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': /font|image/.test(type) ? 'public, max-age=86400' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(path).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://server');
  const parts = url.pathname.split('/');

  if (url.pathname === '/healthz') return json(res, 200, { ok: true, instance, version: config.version });

  // What a speaker plays when a button is pressed. The address names the
  // button, not the station, so it never has to be stored again.
  if (parts[1] === 'stream' && parts.length === 4) {
    const slot = Number.parseInt(parts[3], 10);
    const station = preset(parts[2], slot);
    if (!station) throw new Problem(404, 'There is nothing on that button.');
    if (req.method === 'GET') control.heard(parts[2], slot);
    return proxy.serve(req, res, station, { speaker: speaker(parts[2]).name, slot });
  }

  // The same audio for the browser, so a station can be tried before it goes
  // on a button.
  if (parts[1] === 'preview' && parts.length === 4) {
    guard(req);
    const station = parts[2] === 'station' ? stations.byId(parts[3]) : preset(parts[2], Number(parts[3]));
    if (!station) throw new Problem(404, 'No such station.');
    return proxy.serve(req, res, station, { speaker: 'A browser' });
  }

  if (parts[1] === 'api') return api(req, res, url);
  if (await cloud.handle(req, res, url)) return undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new Problem(405, 'Not allowed');
  return file(req, res, url);
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!(error instanceof Problem)) console.error(`${req.method} ${req.url}:`, error);
    if (res.headersSent) return res.end();
    return json(res, error.status || 500, { error: error instanceof Problem ? error.message : 'Something went wrong on the server. Its log has the details.' });
  });
});

// The station list loads from disk at once and refreshes in the background;
// the setup pages do not wait for it.
stations.start(control.refreshStations);
control.start();
server.listen(config.port, () => {
  console.log(`Air Drift for SoundTouch ${config.version} is listening on port ${config.port}`);
  const address = publicUrl() || (lanAddresses()[0] ? `http://${lanAddresses()[0].address}:${config.port}` : `http://localhost:${config.port}`);
  console.log(state.setupComplete ? `Speakers page: ${address}` : `Open ${address} to set up your speakers`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    control.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
