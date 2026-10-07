// The answers Bose's servers used to give, for speakers that have been
// pointed here. A SoundTouch asks three services:
//
//   "marge"  (/streaming/...)  the account: which presets and sources it has
//   "bmx"    (/bmx/..., /core02/...)  the registry of music services, and
//            the "Orion" adapter that turns a custom-station preset into a
//            stream address
//   stats and software updates, which only need a polite reply
//
// Only what a radio preset needs is here. The account document is rebuilt
// from this server's own settings on every request: the speaker treats it as
// the truth about its six buttons, which is how a station changed in the
// setup pages reaches the speaker.
//
// The formats follow what soundcork, Überböse and AfterTouch recorded from
// the real service.
import { createHash } from 'node:crypto';
import { SLOTS, publicUrl, save, speaker as speakerById, speakers, streamUrl } from '../store.mjs';
import { element, esc, text } from '../xml.mjs';

const MARGE_TYPE = 'application/vnd.bose.streaming-v1.2+xml';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ORION = '/core02/svc-bmx-adapter-orion/prod/orion';
const EPOCH = '2026-01-01T00:00:00.000+00:00';

// Source ids are this server's own; the speaker hands them back when it
// stores a preset. 11 and 25 are Bose's numbers for the two providers.
const RADIO = { id: '10003', provider: 11, token: Buffer.from('{"serial":"local-internet-radio"}').toString('base64') };
const TUNEIN = { id: '10004', provider: 25, token: Buffer.from('{"serial":"tunein"}').toString('base64') };

const PROVIDERS = ['PANDORA', 'INTERNET_RADIO', 'OFF', 'LOCAL', 'AIRPLAY', 'CURRATED_RADIO', 'STORED_MUSIC', 'SLAVE_SOURCE', 'AUX',
  'RECOMMENDED_INTERNET_RADIO', 'LOCAL_INTERNET_RADIO', 'GLOBAL_INTERNET_RADIO', 'HELLO', 'DEEZER', 'SPOTIFY', 'IHEART', 'SIRIUSXM',
  'GOOGLE_PLAY_MUSIC', 'QQMUSIC', 'AMAZON', 'LOCAL_MUSIC', 'WBMX', 'SOUNDCLOUD', 'TIDAL', 'TUNEIN', 'QPLAY', 'JUKE', 'BBC', 'DARFM',
  '7DIGITAL', 'SAAVN', 'RDIO', 'PHONE_MUSIC', 'ALEXA', 'RADIOPLAYER', 'RADIO.COM', 'RADIO_COM', 'SIRIUSXM_EVEREST'];

const seenAt = new Map();
const unknown = new Set();

export const lastSeen = (id) => seenAt.get(id) || null;

const stamp = (iso) => (iso ? new Date(iso) : new Date()).toISOString().replace('Z', '+00:00');

/* ---------- what a preset looks like to the speaker ---------- */

// A custom-station preset points at the Orion adapter with the station
// folded into the address. The stream is this server's address for the
// button, so the folded-in part only changes when the station's name does.
export function location(speaker, slot) {
  const station = speaker.presets[slot - 1];
  const data = { name: station.name, imageUrl: station.icon || '', streamUrl: streamUrl(speaker.id, slot) };
  return `/station?data=${encodeURIComponent(Buffer.from(JSON.stringify(data)).toString('base64'))}`;
}

// Reads that folded-in part back. Other software writes it with either
// base64 alphabet and with or without padding.
export function decodeData(value) {
  try {
    const normal = String(value || '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normal, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// The speaker refuses a whole account if any source lacks sourceproviderid.
const sourceXml = (source) => `<source id="${source.id}" type="Audio"><createdOn>${EPOCH}</createdOn><credential type="token">${source.token}</credential><name></name><sourceproviderid>${source.provider}</sourceproviderid><sourcename></sourcename><sourceSettings/><updatedOn>${EPOCH}</updatedOn><username></username></source>`;

function presetXml(speaker, slot) {
  const station = speaker.presets[slot - 1];
  const made = stamp(speaker.addedAt);
  return `<preset buttonNumber="${slot}"><containerArt>${esc(station.icon || '')}</containerArt><contentItemType>stationurl</contentItemType><createdOn>${made}</createdOn><location>${esc(location(speaker, slot))}</location><name>${esc(station.name)}</name>${sourceXml(RADIO)}<updatedOn>${made}</updatedOn><username>${esc(station.name)}</username></preset>`;
}

const presetsXml = (speaker) => `<presets>${SLOTS.filter((slot) => speaker.presets[slot - 1]).map((slot) => presetXml(speaker, slot)).join('')}</presets>`;

// AUX, Bluetooth and AirPlay are the speaker's own and must not be listed
// here: a stray AUX entry is suspected of breaking the AUX input.
const sourcesXml = () => `<sources>${sourceXml(RADIO)}${sourceXml(TUNEIN)}</sources>`;

const settingsXml = (account) => `<providerSettings><providerSetting><boseId>${esc(account)}</boseId><keyName>ELIGIBLE_FOR_TRIAL</keyName><value>false</value><providerId>14</providerId></providerSetting></providerSettings>`;

function deviceXml(speaker) {
  const made = stamp(speaker.addedAt);
  const label = (speaker.type || 'SoundTouch').toLowerCase().replace(/\s+/g, '_');
  return `<device deviceid="${esc(speaker.id)}"><attachedProduct product_code="${esc(speaker.type || 'SoundTouch')}"><components/><productlabel>${esc(label)}</productlabel><serialnumber>${esc(speaker.serial || '')}</serialnumber></attachedProduct><createdOn>${made}</createdOn><firmwareVersion>${esc(speaker.firmware || '')}</firmwareVersion><ipaddress>${esc(speaker.ip)}</ipaddress><name>${esc(speaker.name)}</name>${presetsXml(speaker)}<recents/><serialNumber>${esc(speaker.serial || '')}</serialNumber><updatedOn>${made}</updatedOn></device>`;
}

export function accountXml(speaker) {
  return `${HEAD}<account id="${esc(speaker.account)}"><accountStatus>OK</accountStatus><devices>${deviceXml(speaker)}</devices><mode>global</mode><preferredLanguage>en</preferredLanguage>${settingsXml(speaker.account)}${sourcesXml()}</account>`;
}

/* ---------- the registry of services ---------- */

function service(base, name, value, path, description, title, links, streamTypes) {
  return {
    _links: links,
    askAdapter: false,
    assets: {
      color: '#000000',
      description,
      icons: { largeSvg: `${base}/icons/icon.svg`, monochromePng: `${base}/icons/icon-192.png`, monochromeSvg: `${base}/icons/icon.svg`, smallSvg: `${base}/icons/icon.svg` },
      name: title,
    },
    authenticationModel: { anonymousAccount: { autoCreate: true, enabled: true } },
    baseUrl: `${base}${path}`,
    id: { name, value },
    streamTypes,
  };
}

const radioService = (base) => service(base, 'LOCAL_INTERNET_RADIO', RADIO.provider, ORION, 'Custom radio stations with BMX.', 'Custom Stations',
  { bmx_token: { href: '/token' }, self: { href: '/' } }, ['liveRadio']);

// Every working replacement lists TuneIn ahead of custom stations, so this
// does too, although nothing answers behind it.
function registry(base) {
  return {
    _links: { bmx_services_availability: { href: '../servicesAvailability' } },
    askAgainAfter: 1230482,
    bmx_services: [
      service(base, 'TUNEIN', TUNEIN.provider, '/bmx/tunein', 'TuneIn is not available from this server.', 'TuneIn',
        { bmx_navigate: { href: '/v1/navigate' }, bmx_token: { href: '/v1/token' }, self: { href: '/' } }, ['liveRadio', 'onDemand']),
      radioService(base),
    ],
  };
}

const UPDATES = `<?xml version="1.0" encoding="UTF-8"?>
<INDEX REVISION="02.11.00">
${[['0x0923', 'SoundTouch 20'], ['0x0924', 'SoundTouch 30']].map(([id, name]) => `  <DEVICE ID="${id}" PRODUCTNAME="${name}">
    <HARDWARE REVISION="00.01.00">
      <RELEASE REVISION="27.0.6.46330.5043500" HTTPHOST="https://downloads.bose.com" URLPATH="ced/soundtouch/mr4_22097fe2" USBPATH="/ced/soundtouch/mr4_22097fe2/stu/s/Update.stu">
        <IMAGE SUBID="0" LENGTH="105879988" CRC="0x2d5a971e" FILENAME="Update_ti_27.0.6.46330.5043500.scm.stu" />
      </RELEASE>
    </HARDWARE>
  </DEVICE>`).join('\n')}
</INDEX>
`;

/* ---------- replies ---------- */

// The header has to be spelled "ETag" exactly; the speaker ignores "etag".
function marge(req, res, status, body, headers = {}) {
  const tag = createHash('sha1').update(body).digest('hex');
  if (status === 200 && String(req.headers['if-none-match'] || '').replace(/"/g, '') === tag) {
    res.writeHead(304, { ETag: tag });
    res.end();
    return true;
  }
  res.writeHead(status, { 'Content-Type': MARGE_TYPE, ETag: tag, ...headers });
  res.end(body);
  return true;
}

function send(res, status, type, body = '', headers = {}) {
  res.writeHead(status, type ? { 'Content-Type': type, ...headers } : headers);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
  return true;
}

async function read(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 262_144) break;
  }
  return raw;
}

function owner(account, device) {
  const found = (device && speakerById(device)) || speakers().find((entry) => entry.account && entry.account === account) || null;
  if (found) seenAt.set(found.id, new Date().toISOString());
  return found;
}

// A speaker stores a preset here after a long press on a button. If what it
// is storing is one of this server's own buttons, the station moves to the
// new button; anything else is acknowledged and left to the setup pages.
function adopt(speaker, slot, body) {
  const data = decodeData(new URLSearchParams(text(body, 'location').split('?')[1] || '').get('data'));
  const from = /\/stream\/([^/]+)\/(\d)/.exec(data?.streamUrl || '');
  const source = from && from[1] === speaker.id ? speaker.presets[Number(from[2]) - 1] : null;
  if (!source || Number(from[2]) === slot) return;
  speaker.presets[slot - 1] = structuredClone(source);
  save();
}

async function streaming(req, res, parts) {
  const method = req.method;
  const path = parts.join('/');

  if (path === 'support/power_on') {
    const id = element(await read(req), 'device')?.attrs.id;
    if (id && speakerById(id)) seenAt.set(id, new Date().toISOString());
    return send(res, 200, MARGE_TYPE);
  }
  if (path === 'support/customersupport') return send(res, 200, MARGE_TYPE);
  if (path === 'sourceproviders') {
    return marge(req, res, 200, `${HEAD}<sourceProviders>${PROVIDERS.map((name, i) => `<sourceprovider id="${i + 1}"><createdOn>2012-09-19T12:43:00.000+00:00</createdOn><name>${name}</name><updatedOn>2012-09-19T12:43:00.000+00:00</updatedOn></sourceprovider>`).join('')}</sourceProviders>`);
  }
  if (parts[0] === 'device' && parts[2] === 'streaming_token') return send(res, 200, MARGE_TYPE, '', { Authorization: 'Bearer local', ETag: 'local' });
  if (parts[0] === 'software' && parts[1] === 'update') return marge(req, res, 200, `${HEAD}<software_update><softwareUpdateLocation></softwareUpdateLocation></software_update>`);
  if (parts[0] !== 'account') return false;

  const account = parts[1];
  const [, , what, device, sub, number] = parts;
  const speaker = owner(account, what === 'device' ? device : null);

  // Pairing: the speaker introduces itself to its new account.
  if (what === 'device' && !sub && (method === 'POST' || method === 'PUT')) {
    const body = await read(req);
    const id = device || element(body, 'device')?.attrs.deviceid || '';
    const known = speakerById(id);
    if (known) {
      known.account = account;
      save();
      seenAt.set(id, new Date().toISOString());
    }
    const now = stamp();
    const reply = `${HEAD}<device deviceid="${esc(id)}"><createdOn>${now}</createdOn><ipaddress>${esc(known?.ip || '')}</ipaddress><name>${esc(text(body, 'name') || known?.name || '')}</name><updatedOn>${now}</updatedOn></device>`;
    const headers = { Location: `${publicUrl()}/account/${account}/device/${id}`, METHOD_NAME: 'addDevice' };
    if (req.headers.authorization) headers.Credentials = req.headers.authorization;
    return marge(req, res, method === 'POST' ? 201 : 200, reply, headers);
  }
  if (what === 'device' && !sub && method === 'DELETE') return send(res, 200, MARGE_TYPE);

  if (!speaker) return send(res, 404, MARGE_TYPE, `${HEAD}<status><message>Account does not exist</message><status-code>4012</status-code></status>`);

  if (what === 'full') return marge(req, res, 200, accountXml(speaker), { METHOD_NAME: 'getFullAccount' });
  if (what === 'sources') return marge(req, res, 200, `${HEAD}${sourcesXml()}`);
  if (what === 'devices') return marge(req, res, 200, `${HEAD}<devices>${deviceXml(speaker)}</devices>`);
  if (what === 'provider_settings') return marge(req, res, 200, `${HEAD}${settingsXml(account)}`);
  if (what === 'presets' && device === 'all') return marge(req, res, 200, `${HEAD}${presetsXml(speaker)}`);
  if (what !== 'device') return false;

  if (sub === 'presets' && !number) return marge(req, res, 200, `${HEAD}${presetsXml(speaker)}`);
  if (sub === 'preset' || sub === 'presets') {
    const slot = Number(number);
    if (!SLOTS.includes(slot)) return send(res, 404, MARGE_TYPE);
    if (method === 'DELETE') return send(res, 200, MARGE_TYPE);
    const body = await read(req);
    adopt(speaker, slot, body);
    if (speaker.presets[slot - 1]) return marge(req, res, 200, `${HEAD}${presetXml(speaker, slot)}`);
    // Not one of ours: say yes, in the shape the speaker expects.
    const now = stamp();
    const label = text(body, 'name') || text(body, 'username');
    return marge(req, res, 200, `${HEAD}<preset buttonNumber="${slot}"><containerArt>${esc(text(body, 'containerArt'))}</containerArt><contentItemType>${esc(text(body, 'contentItemType') || 'stationurl')}</contentItemType><createdOn>${now}</createdOn><location>${esc(text(body, 'location'))}</location><name>${esc(label)}</name>${sourceXml(RADIO)}<updatedOn>${now}</updatedOn><username>${esc(label)}</username></preset>`);
  }
  if (sub === 'recents' || (sub === 'recent' && method === 'GET')) return marge(req, res, 200, `${HEAD}<recents/>`);
  if (sub === 'recent') {
    // What was played is acknowledged and not kept.
    const body = await read(req);
    const now = stamp();
    return marge(req, res, 201, `${HEAD}<recent id="1"><contentItemType>${esc(text(body, 'contentItemType') || 'stationurl')}</contentItemType><createdOn>${now}</createdOn><lastplayedat>${now}</lastplayedat><location>${esc(text(body, 'location'))}</location><name>${esc(text(body, 'name'))}</name>${sourceXml(RADIO)}<sourceid>${RADIO.id}</sourceid><updatedOn>${now}</updatedOn></recent>`);
  }
  if (sub === 'group') return marge(req, res, 200, `${HEAD}<groups/>`);
  return false;
}

async function orion(req, res, url, rest) {
  const base = publicUrl();
  if (rest === '' || rest === '/') return send(res, 200, 'application/json', radioService(base));
  if (rest === '/token') return send(res, 200, 'application/json', { _embedded: { bmx_account: { displayName: '', username: '' } }, access_token: RADIO.token, refresh_token: RADIO.token });
  if (rest !== '/station') return false;
  const data = decodeData(url.searchParams.get('data'));
  if (!data?.streamUrl) return send(res, 400, 'application/json', { error: 'data is missing or unreadable' });
  // The address stored on the speaker may name an older address of this
  // server. The button it names is still right, so answer with today's.
  const ours = /\/stream\/([^/]+)\/(\d)(?:\.\w+)?$/.exec(data.streamUrl);
  const speaker = ours && speakerById(ours[1]);
  const station = speaker?.presets[Number(ours[2]) - 1];
  const streamAddress = station ? streamUrl(speaker.id, Number(ours[2])) : data.streamUrl;
  if (speaker) seenAt.set(speaker.id, new Date().toISOString());
  const stream = { hasPlaylist: true, isRealtime: true, streamUrl: streamAddress };
  return send(res, 200, 'application/json', { audio: { ...stream, streams: [stream] }, imageUrl: station?.icon || data.imageUrl || '', name: station?.name || data.name || '', streamType: 'liveRadio' });
}

// Answers a request if it is one a speaker makes of Bose. Returns false for
// anything else, which the setup pages then handle.
export async function handle(req, res, url) {
  const path = url.pathname.replace(/\/{2,}/g, '/');
  const base = publicUrl();
  let done = false;

  if (path.startsWith('/streaming/')) done = await streaming(req, res, path.slice(11).replace(/\/$/, '').split('/'));
  else if (path === '/bmx/registry/v1/services') done = send(res, 200, 'application/json', registry(base));
  else if (path === '/bmx/registry/v1/servicesAvailability') done = send(res, 200, 'application/json', { services: [{ canAdd: false, canRemove: false, service: 'TUNEIN' }] }, { 'X-Bmx-Adapter-Version': 'master.4.40' });
  else if (path.startsWith(ORION)) done = await orion(req, res, url, path.slice(ORION.length));
  else if (/^\/v1\/(scmudc|stapp)\//.test(path)) {
    await read(req);
    done = send(res, 200, null);
  } else if (path === '/updates/soundtouch') done = send(res, 200, 'application/xml', UPDATES, { ETag: 'default-embedded' });
  else if (!/^\/(bmx|core02|v1|oauth|marge)(\/|$)/.test(path)) return false;

  if (!done) {
    // Something a speaker asked for that is not answered here. Logged once,
    // so a gap in this list shows up in the container's log.
    const key = `${req.method} ${path.replace(/\d{5,}|[0-9A-F]{12}/g, ':id')}`;
    if (!unknown.has(key) && unknown.size < 200) {
      unknown.add(key);
      console.log(`cloud: no answer for ${key}`);
    }
    send(res, 404, null);
  }
  return true;
}
