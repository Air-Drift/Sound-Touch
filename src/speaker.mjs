// The speaker's own control API: XML over plain HTTP on port 8090, no login.
// Bose documents most of it in the SoundTouch Web API; /storePreset is the
// one the app used and the document leaves out.
import { config } from './config.mjs';
import { element, elements, esc, text } from './xml.mjs';

const WAIT = 6_000;

async function call(ip, path, body) {
  const response = await fetch(`http://${ip}:8090${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/xml', 'User-Agent': config.userAgent } : { 'User-Agent': config.userAgent },
    body,
    signal: AbortSignal.timeout(WAIT),
  });
  const xml = await response.text();
  if (!response.ok || /<errors?[\s>]/.test(xml)) {
    throw new Error(text(xml, 'error') || `the speaker answered HTTP ${response.status} to ${path}`);
  }
  return xml;
}

export async function info(ip) {
  const xml = await call(ip, '/info');
  const root = element(xml, 'info');
  if (!root?.attrs.deviceID) throw new Error('that address answered, but not as a SoundTouch speaker');
  const scm = elements(xml, 'component').find((part) => text(part.inner, 'componentCategory') === 'SCM');
  return {
    id: root.attrs.deviceID,
    name: text(xml, 'name') || 'SoundTouch',
    type: text(xml, 'type'),
    firmware: scm ? text(scm.inner, 'softwareVersion') : '',
    serial: scm ? text(scm.inner, 'serialNumber') : '',
    account: text(xml, 'margeAccountUUID'),
    margeUrl: text(xml, 'margeURL'),
    mac: text(xml, 'macAddress'),
  };
}

function contentItem(node) {
  if (!node) return null;
  return {
    source: node.attrs.source || '',
    type: node.attrs.type || '',
    location: node.attrs.location || '',
    sourceAccount: node.attrs.sourceAccount || '',
    name: text(node.inner, 'itemName'),
    art: text(node.inner, 'containerArt'),
  };
}

export async function presets(ip) {
  const xml = await call(ip, '/presets');
  return elements(xml, 'preset').map((node) => ({ slot: Number(node.attrs.id), ...contentItem(element(node.inner, 'ContentItem')) }));
}

export async function nowPlaying(ip) {
  const xml = await call(ip, '/now_playing');
  const root = element(xml, 'nowPlaying');
  return {
    source: root?.attrs.source || '',
    item: contentItem(element(xml, 'ContentItem')),
    station: text(xml, 'stationName'),
    track: text(xml, 'track'),
    artist: text(xml, 'artist'),
    status: text(xml, 'playStatus'),
  };
}

export async function sources(ip) {
  const xml = await call(ip, '/sources');
  return elements(xml, 'sourceItem').map((node) => ({
    source: node.attrs.source,
    account: node.attrs.sourceAccount || '',
    ready: node.attrs.status === 'READY',
  }));
}

export function contentItemXml(item) {
  const attrs = ['source', 'type', 'location', 'sourceAccount']
    .filter((name) => item[name] !== undefined && item[name] !== null)
    .map((name) => `${name}="${esc(item[name])}"`)
    .join(' ');
  const art = item.art ? `<containerArt>${esc(item.art)}</containerArt>` : '';
  return `<ContentItem ${attrs} isPresetable="true"><itemName>${esc(item.name)}</itemName>${art}</ContentItem>`;
}

export const storePreset = (ip, slot, item) =>
  call(ip, '/storePreset', `<preset id="${Number(slot)}">${contentItemXml(item)}</preset>`);

export const removePreset = (ip, slot) => call(ip, '/removePreset', `<preset id="${Number(slot)}"></preset>`);

export const select = (ip, item) => call(ip, '/select', contentItemXml(item));

// Joins a speaker that has no account to one. The speaker does not check the
// values; it only needs to have some. An empty body here can un-pair a
// speaker, so the id is checked first.
export function pair(ip, account) {
  if (!/^\d{7}$/.test(account)) throw new Error('an account id is seven digits');
  return call(ip, '/setMargeAccount', `<PairDeviceWithAccount><accountId>${account}</accountId><userAuthToken>local</userAuthToken></PairDeviceWithAccount>`);
}

// A key is a press and a release, as the remote sends them.
export async function key(ip, name) {
  await call(ip, '/key', `<key state="press" sender="Gabbo">${esc(name)}</key>`);
  await call(ip, '/key', `<key state="release" sender="Gabbo">${esc(name)}</key>`);
}
