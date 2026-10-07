// The station directory. airdrift.stream publishes it as static JSON and
// nothing else, so this keeps a copy in the data volume and does all the
// searching and filtering here.
//
//   index.json          counts and file names for countries and genres
//   popular.json        the most played stations
//   country/XX.json     every working station in a country
//
// The country files between them hold every station, so the genre files are
// never fetched. Each request carries the ETag of the copy on disk, and a file
// that has not changed costs a 304.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const dir = join(config.dataDir, 'stations');
const PARALLEL = 4;
// Codecs the speaker decodes itself. Anything else, and every HLS stream, is
// converted on the way through.
const NATIVE = /^(MP3|AAC)/i;

const dirState = {
  index: null,
  stations: [],
  byId: new Map(),
  popular: [],
  lastSync: null,
  lastError: null,
  syncing: false,
};

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const readJson = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return fallback;
  }
};

function writeJson(name, value) {
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value));
  renameSync(tmp, join(dir, name));
}

const countryFile = (code) => `country-${code}.json`;

export function needsTranscode(station) {
  return Boolean(station.hls) || /\.m3u8(\?|$)/i.test(station.url) || !NATIVE.test(station.codec || 'MP3');
}

// What the wizard and the API show for a station.
export function view(station) {
  if (!station) return null;
  const { key, nameKey, ...rest } = station;
  return { ...rest, transcode: needsTranscode(station) };
}

function usable(row) {
  return row && typeof row.id === 'string' && typeof row.name === 'string' && /^https?:\/\//i.test(row.url || '');
}

function load() {
  const index = readJson('index.json', null);
  if (!index) return false;
  const byId = new Map();
  for (const country of index.countries || []) {
    for (const row of readJson(countryFile(country.value), [])) {
      if (!usable(row) || byId.has(row.id)) continue;
      row.tags = Array.isArray(row.tags) ? row.tags : [];
      row.nameKey = fold(row.name);
      row.key = `${row.nameKey} ${fold(`${row.tags.join(' ')} ${row.region || ''}`)}`;
      byId.set(row.id, row);
    }
  }
  dirState.index = index;
  dirState.byId = byId;
  dirState.stations = [...byId.values()].sort((a, b) => (b.clicks || 0) - (a.clicks || 0) || (b.votes || 0) - (a.votes || 0));
  dirState.popular = readJson('popular.json', []).filter(usable);
  dirState.lastSync = readJson('sync.json', {}).lastSync || null;
  return true;
}

async function fetchFile(path, etags) {
  const headers = { 'User-Agent': config.userAgent, Accept: 'application/json' };
  if (etags[path]) headers['If-None-Match'] = etags[path];
  const response = await fetch(`${config.airdriftBase}/${path}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (response.status === 304) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body = await response.text();
  JSON.parse(body);
  return { body, etag: response.headers.get('etag') };
}

// Brings the copy on disk up to date. Files are swapped in one at a time and
// the index goes last, so an interrupted run leaves a usable directory.
export async function sync({ force = false } = {}) {
  if (dirState.syncing) return status();
  dirState.syncing = true;
  try {
    mkdirSync(dir, { recursive: true });
    const etags = force ? {} : readJson('etags.json', {});
    const onDisk = new Set(readdirSync(dir));

    const fetched = await fetchFile('index.json', etags);
    const index = fetched ? JSON.parse(fetched.body) : readJson('index.json', null);
    if (!index || !Array.isArray(index.countries) || !index.countries.length) throw new Error('index.json has no countries');

    const jobs = index.countries.map((country) => ({ path: `${country.file}.json`, name: countryFile(country.value) }));
    jobs.push({ path: 'popular.json', name: 'popular.json' });
    let changed = 0;
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        // A file missing from disk is fetched whatever its ETag says.
        const known = onDisk.has(job.name) ? etags : {};
        const result = await fetchFile(job.path, known);
        if (!result) continue;
        if (!Array.isArray(JSON.parse(result.body))) throw new Error(`${job.path} is not a list of stations`);
        writeJson(job.name, result.body);
        if (result.etag) etags[job.path] = result.etag;
        changed += 1;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    const wanted = new Set(jobs.map((job) => job.name));
    for (const name of onDisk) {
      if (name.startsWith('country-') && name.endsWith('.json') && !wanted.has(name)) rmSync(join(dir, name), { force: true });
    }
    if (fetched) {
      writeJson('index.json', fetched.body);
      if (fetched.etag) etags['index.json'] = fetched.etag;
    }
    writeJson('etags.json', etags);
    dirState.lastSync = new Date().toISOString();
    writeJson('sync.json', { lastSync: dirState.lastSync });
    dirState.lastError = null;
    if (changed || fetched || !dirState.index) load();
    console.log(`stations: ${dirState.stations.length} stations, ${changed} file(s) updated`);
  } catch (error) {
    dirState.lastError = error.message;
    console.warn(`stations: sync failed, keeping the copy on disk (${error.message})`);
  } finally {
    dirState.syncing = false;
  }
  return status();
}

export function status() {
  return {
    count: dirState.stations.length,
    generated: dirState.index?.meta?.generated || null,
    lastSync: dirState.lastSync,
    lastError: dirState.lastError,
    syncing: dirState.syncing,
    source: config.airdriftBase,
  };
}

export function facets() {
  const strip = (list) => (list || []).map(({ value, count }) => ({ value, count }));
  return { countries: strip(dirState.index?.countries), genres: strip(dirState.index?.genres) };
}

export const byId = (id) => dirState.byId.get(id) || null;

export function popular(limit = 24) {
  const list = dirState.popular.length ? dirState.popular : dirState.stations;
  return list.slice(0, limit).map(view);
}

// Every word typed has to appear in the name, the tags or the region.
// Stations with all of them in the name come first, then the rest, each most
// played first: a search for "jazz" should lead with stations called jazz.
export function search({ q = '', country = '', genre = '', limit = 30, offset = 0 } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const code = country.toUpperCase();
  const tag = genre.toLowerCase();
  const max = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);
  const named = [];
  const others = [];
  for (const station of dirState.stations) {
    if (code && station.country !== code) continue;
    if (tag && !station.tags.includes(tag)) continue;
    if (!words.every((word) => station.key.includes(word))) continue;
    (words.length && !words.every((word) => station.nameKey.includes(word)) ? others : named).push(station);
  }
  const found = named.concat(others);
  return { total: found.length, stations: found.slice(skip, skip + max).map(view) };
}

// Loads what is on disk, fetches if there is nothing or it is old, and then
// checks back on a timer.
export async function start(onChange = () => {}) {
  mkdirSync(dir, { recursive: true });
  const cached = load();
  const interval = config.syncHours * 3_600_000;
  const stale = !dirState.lastSync || Date.now() - Date.parse(dirState.lastSync) > interval;
  const run = () => sync().then(onChange);
  if (!cached) await run();
  else if (stale) run();
  // Spread installs across the hour rather than have them all ask at once.
  setInterval(run, interval + Math.random() * 3_600_000).unref();
}
