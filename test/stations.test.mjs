// The station directory against a stand-in for airdrift.stream.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const files = {
  '/index.json': {
    meta: { generated: '2026-10-07T09:45:05.954Z', count: 4 },
    genres: [{ value: 'jazz', count: 2, file: 'tag/jazz-abc' }],
    countries: [{ value: 'FR', count: 2, file: 'country/FR' }, { value: 'US', count: 2, file: 'country/US' }],
  },
  '/popular.json': [{ id: 'us-1', name: 'KEXP 90.3 FM', url: 'https://kexp.example/stream', country: 'US', codec: 'MP3' }],
  '/country/FR.json': [
    { id: 'fr-1', name: 'Jazz Radio', url: 'http://jazz.example/high.mp3', tags: ['jazz'], country: 'FR', codec: 'MP3', bitrate: 192, clicks: 50 },
    { id: 'fr-2', name: 'Café Crème', url: 'https://cafe.example/live.m3u8', tags: ['jazz', 'lounge'], country: 'FR', codec: 'AAC', hls: 1, clicks: 80 },
  ],
  '/country/US.json': [
    { id: 'us-1', name: 'KEXP 90.3 FM', url: 'https://kexp.example/stream', tags: ['indie'], country: 'US', codec: 'MP3', clicks: 900, region: 'Washington' },
    { id: 'us-2', name: 'Vorbis FM', url: 'https://ogg.example/stream', tags: [], country: 'US', codec: 'OGG', clicks: 5 },
    { id: 'bad', name: 'No address', country: 'US' },
  ],
};

let server;
let dataDir;
let stations;
let requests = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push({ url: req.url, etag: req.headers['if-none-match'] });
    const body = files[req.url];
    if (!body) return res.writeHead(404).end();
    const etag = `"${JSON.stringify(body).length}"`;
    if (req.headers['if-none-match'] === etag) return res.writeHead(304).end();
    return res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag }).end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  dataDir = mkdtempSync(join(tmpdir(), 'sound-touch-'));
  process.env.DATA_DIR = dataDir;
  process.env.AIRDRIFT_BASE = `http://127.0.0.1:${server.address().port}`;
  stations = await import('../src/stations.mjs');
  await stations.sync();
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('loads every usable station from the country files', () => {
  assert.equal(stations.status().count, 4);
  assert.equal(stations.status().lastError, null);
  assert.equal(stations.byId('bad'), null);
});

test('searches by name, most played first, ignoring accents and case', () => {
  assert.deepEqual(stations.search({}).stations.map((s) => s.id), ['us-1', 'fr-2', 'fr-1', 'us-2']);
  assert.deepEqual(stations.search({ q: 'cafe creme' }).stations.map((s) => s.id), ['fr-2']);
  assert.deepEqual(stations.search({ q: 'washington' }).stations.map((s) => s.id), ['us-1']);
  assert.equal(stations.search({ q: 'nothing like this' }).total, 0);
});

test('puts stations named for the search ahead of ones only tagged with it', () => {
  // Café Crème is played more, but is only tagged jazz.
  assert.deepEqual(stations.search({ q: 'jazz' }).stations.map((s) => s.id), ['fr-1', 'fr-2']);
});

test('filters by country and genre, and pages', () => {
  assert.deepEqual(stations.search({ country: 'fr', genre: 'Jazz' }).stations.map((s) => s.id), ['fr-2', 'fr-1']);
  const page = stations.search({ limit: 1, offset: 1 });
  assert.equal(page.total, 4);
  assert.deepEqual(page.stations.map((s) => s.id), ['fr-2']);
});

test('marks the stations a speaker cannot decode itself', () => {
  assert.equal(stations.search({ q: 'kexp' }).stations[0].transcode, false);
  assert.equal(stations.search({ q: 'cafe' }).stations[0].transcode, true);
  assert.equal(stations.search({ q: 'vorbis' }).stations[0].transcode, true);
});

test('a second sync sends ETags and downloads nothing', async () => {
  requests = [];
  await stations.sync();
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.etag), 'every request is conditional');
  assert.equal(stations.status().count, 4);
});

test('keeps the copy on disk when the site is unreachable', async () => {
  const saved = files['/index.json'];
  delete files['/index.json'];
  await stations.sync({ force: true });
  files['/index.json'] = saved;
  assert.match(stations.status().lastError, /404/);
  assert.equal(stations.status().count, 4);
});
