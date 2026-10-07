// The speaker plays MP3 and AAC over plain HTTP and little else. Most
// stations are HTTPS and a fair share are HLS or another codec, so every
// station reaches the speaker through here: passed straight through where
// the speaker can decode it, converted by ffmpeg where it cannot.
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { config } from './config.mjs';
import { needsTranscode } from './stations.mjs';

const PLAYLIST = /mpegurl|scpls|^text\/|\/xml|\/html/i;
const FOREIGN = /ogg|opus|flac|x-ms-|wma|webm|matroska|video\//i;
const ICY_HEADERS = ['icy-metaint', 'icy-name', 'icy-genre', 'icy-br', 'icy-url', 'icy-description'];
const HEADER_WAIT = 15_000;
const FIRST_AUDIO_WAIT = 25_000;

// What is playing right now, for the health page.
export const active = new Map();
let serial = 0;

export const ffmpeg = (() => {
  let found = null;
  return () => {
    if (found === null) {
      const run = spawnSync(config.ffmpeg, ['-version'], { encoding: 'utf8' });
      found = run.status === 0 ? run.stdout.split('\n')[0].replace(/ Copyright.*/, '') : false;
    }
    return found;
  };
})();

async function get(url, { icy = false, signal } = {}) {
  const headers = { 'User-Agent': config.userAgent, Accept: '*/*' };
  if (icy) headers['Icy-MetaData'] = '1';
  const timeout = AbortSignal.timeout(HEADER_WAIT);
  // The timeout covers the wait for headers only; the stream itself runs on
  // the caller's signal, which is the listener hanging up.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  timeout.addEventListener('abort', cancel);
  signal?.addEventListener('abort', cancel);
  try {
    return await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
  } finally {
    timeout.removeEventListener('abort', cancel);
  }
}

// The first address in a .pls or plain .m3u playlist.
export function firstEntry(body, base) {
  for (const line of body.split(/\r?\n/)) {
    const found = /^(?:File\d+\s*=\s*)?(https?:\/\/\S+)/i.exec(line.trim());
    if (found) return found[1];
    if (line.trim() && !/^[#[<]|^\w+\s*=|\s/.test(line.trim())) {
      try {
        return new URL(line.trim(), base).href;
      } catch { /* not an address */ }
    }
  }
  return null;
}

// Follows playlists down to the audio and decides how it gets to the speaker:
// { via: 'direct', response } or { via: 'ffmpeg', url }.
export async function open(station, { icy = false, signal } = {}) {
  let url = station.url;
  if (needsTranscode(station)) return { via: 'ffmpeg', url };
  for (let hop = 0; hop < 4; hop += 1) {
    let response;
    try {
      response = await get(url, { icy, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Old Shoutcast servers answer "ICY 200 OK", which is not HTTP.
      // ffmpeg speaks it.
      if (String(error.cause?.code).startsWith('HPE_')) return { via: 'ffmpeg', url, reason: 'legacy' };
      if (error.name === 'AbortError') throw new Error('no answer in 15 seconds');
      throw new Error(error.cause?.message || error.message);
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw new Error(`the station answered HTTP ${response.status}`);
    }
    const type = response.headers.get('content-type') || '';
    if (FOREIGN.test(type)) {
      response.body?.cancel().catch(() => {});
      return { via: 'ffmpeg', url: response.url || url, reason: type };
    }
    if (!PLAYLIST.test(type)) return { via: 'direct', response, type: type.split(';')[0] || 'audio/mpeg' };

    const body = (await response.text()).slice(0, 65_536);
    const here = response.url || url;
    if (/#EXT-X-/.test(body)) return { via: 'ffmpeg', url: here, reason: 'HLS' };
    const next = firstEntry(body, here);
    if (!next) throw new Error('the station sent a page, not audio');
    url = next;
  }
  throw new Error('too many playlists inside playlists');
}

function convert(url, copyAac) {
  const codec = copyAac ? ['-c:a', 'copy', '-f', 'adts'] : ['-c:a', 'libmp3lame', '-b:a', `${config.mp3Bitrate}k`, '-f', 'mp3'];
  return spawn(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-user_agent', config.userAgent,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url, '-vn', '-map', '0:a:0', ...codec, 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// Resolves once ffmpeg has produced audio, so a station that fails can still
// be answered with an error status.
function firstAudio(child) {
  return new Promise((resolve, reject) => {
    let errors = '';
    const timer = setTimeout(() => finish(new Error('no audio after 25 seconds')), FIRST_AUDIO_WAIT);
    const finish = (error, chunk) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      child.off('error', finish);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(chunk);
    };
    const onData = (chunk) => {
      child.stdout.pause();
      finish(null, chunk);
    };
    const onClose = () => finish(new Error(errors.trim().split('\n').pop() || 'the converter stopped without audio'));
    child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-2000); });
    child.stdout.on('data', onData);
    child.on('close', onClose);
    child.on('error', finish);
  });
}

async function sendConverted(res, url, station, signal) {
  if (!ffmpeg()) throw new Error('this station needs converting and ffmpeg is not installed');
  // AAC inside HLS is repackaged untouched; anything else becomes MP3.
  const attempts = /^AAC/i.test(station.codec || '') ? [true, false] : [false];
  let failure;
  for (const copyAac of attempts) {
    if (signal.aborted) return;
    const child = convert(url, copyAac);
    const stop = () => child.kill('SIGKILL');
    signal.addEventListener('abort', stop);
    try {
      const chunk = await firstAudio(child);
      res.writeHead(200, { 'Content-Type': copyAac ? 'audio/aac' : 'audio/mpeg', 'Cache-Control': 'no-store', Connection: 'close' });
      res.write(chunk);
      child.stdout.pipe(res);
      child.stdout.resume();
      await new Promise((resolve) => child.on('close', resolve));
      return;
    } catch (error) {
      failure = error;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  throw failure;
}

// Answers one request for a station with its audio. `label` says who is
// listening, for the health page.
export async function serve(req, res, station, label = {}) {
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': /^AAC/i.test(station.codec || '') ? 'audio/aac' : 'audio/mpeg', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const id = ++serial;
  const entry = { ...label, station: station.name, since: new Date().toISOString(), via: 'connecting' };
  active.set(id, entry);
  try {
    const icy = req.headers['icy-metadata'] === '1';
    const source = await open(station, { icy, signal: abort.signal });
    entry.via = source.via;
    if (source.via === 'ffmpeg') {
      await sendConverted(res, source.url, station, abort.signal);
      return;
    }
    const headers = { 'Content-Type': source.type, 'Cache-Control': 'no-store', Connection: 'close' };
    for (const name of ICY_HEADERS) {
      const value = source.response.headers.get(name);
      if (value && (icy || name !== 'icy-metaint')) headers[name] = value;
    }
    res.writeHead(200, headers);
    await new Promise((resolve) => {
      const body = Readable.fromWeb(source.response.body);
      body.on('error', resolve);
      res.on('close', resolve);
      body.pipe(res);
    });
  } catch (error) {
    if (!abort.signal.aborted) {
      console.warn(`stream: ${station.name}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Could not play ${station.name}: ${error.message}\n`);
      }
    }
  } finally {
    abort.abort();
    active.delete(id);
    if (!res.writableEnded) res.end();
  }
}

// A quick look at whether a station answers, without playing it.
export async function probe(station) {
  const abort = new AbortController();
  try {
    const source = await open(station, { signal: abort.signal });
    if (source.via === 'direct') return { ok: true, via: 'direct', detail: source.type };
    if (!ffmpeg()) return { ok: false, via: 'ffmpeg', detail: 'needs converting, and ffmpeg is missing' };
    if (source.reason === 'legacy') return { ok: true, via: 'ffmpeg', detail: 'converted (legacy server)' };
    const response = await get(source.url, { signal: abort.signal });
    return response.ok
      ? { ok: true, via: 'ffmpeg', detail: `converted${station.hls ? ' from HLS' : ''}` }
      : { ok: false, via: 'ffmpeg', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, via: 'none', detail: error.message };
  } finally {
    abort.abort();
  }
}
