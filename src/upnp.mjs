// Starting a stream on a speaker through its UPnP renderer on port 8091.
// This path needs nothing from Bose and nothing changed on the speaker. It
// only accepts plain http:// addresses, which is why every station is served
// from this server.
import { config } from './config.mjs';
import { elements, esc, text } from './xml.mjs';

const SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';
const controls = new Map();

// The control address comes from the renderer's description. Speakers that
// do not publish one at the usual place use the conventional path.
async function controlUrl(speaker) {
  if (controls.has(speaker.id)) return controls.get(speaker.id);
  const base = `http://${speaker.ip}:8091`;
  let url = `${base}/AVTransport/Control`;
  try {
    const response = await fetch(`${base}/XD/BO5EBO5E-F00D-F00D-FEED-${speaker.id}.xml`, { signal: AbortSignal.timeout(4_000) });
    if (response.ok) {
      const description = await response.text();
      const service = elements(description, 'service').find((entry) => /AVTransport/.test(text(entry.inner, 'serviceId')));
      const path = service && text(service.inner, 'controlURL');
      if (path) url = new URL(path, base).href;
    }
  } catch { /* fall back to the conventional path */ }
  controls.set(speaker.id, url);
  return url;
}

async function soap(speaker, action, args) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${SERVICE}"><InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`;
  const response = await fetch(await controlUrl(speaker), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${SERVICE}#${action}"`, 'User-Agent': config.userAgent },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const fault = await response.text();
    controls.delete(speaker.id);
    throw new Error(text(fault, 'errorDescription') || text(fault, 'faultstring') || `the speaker answered HTTP ${response.status} to ${action}`);
  }
}

// The metadata is what the speaker shows; without it the display stays blank.
export function didl({ url, title, art, mime }) {
  const cover = art ? `<upnp:albumArtURI>${esc(art)}</upnp:albumArtURI>` : '';
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${esc(title)}</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class>${cover}<res protocolInfo="http-get:*:${mime}:*">${esc(url)}</res></item></DIDL-Lite>`;
}

export async function play(speaker, { url, title, art, mime = 'audio/mpeg' }) {
  // Stopping first clears whatever the speaker began by itself; a speaker
  // that was idle refuses the stop, which is fine.
  await soap(speaker, 'Stop', '').catch(() => {});
  await soap(speaker, 'SetAVTransportURI', `<CurrentURI>${esc(url)}</CurrentURI><CurrentURIMetaData>${esc(didl({ url, title, art, mime }))}</CurrentURIMetaData>`);
  await soap(speaker, 'Play', '<Speed>1</Speed>');
}
