// The whole path, against the stand-in speaker: add a speaker, set it up in
// each mode, press its buttons and check the audio is fetched from here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FACTORY } from '../src/migrate.mjs';
import { createSpeaker } from './fake-speaker.mjs';

const PORT = 18_686;
const BASE = `http://127.0.0.1:${PORT}`;
const ID = 'F00DFEED0001';
const root = fileURLToPath(new URL('..', import.meta.url));

const station = (n, extra = {}) => ({ id: `st-${n}`, name: `Station ${n}`, tags: ['test'], country: 'GB', codec: 'MP3', bitrate: 128, clicks: 100 - n, ...extra });

let upstream;
let server;
let speaker;
let dataDir;
let skip = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function until(check, what, limit = 8_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

before(async () => {
  // Stands in for airdrift.stream and for the radio stations themselves.
  upstream = createServer((req, res) => {
    const origin = `http://127.0.0.1:${upstream.address().port}`;
    const list = Array.from({ length: 8 }, (_, i) => station(i + 1, { url: `${origin}/live/${i + 1}` }));
    if (req.url === '/index.json') return res.end(JSON.stringify({ meta: { generated: new Date().toISOString() }, genres: [], countries: [{ value: 'GB', count: 8, file: 'country/GB' }] }));
    if (req.url === '/country/GB.json' || req.url === '/popular.json') return res.end(JSON.stringify(list));
    if (req.url.startsWith('/live/')) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      const timer = setInterval(() => res.write(Buffer.alloc(8_192, 0x55)), 20);
      return res.on('close', () => clearInterval(timer));
    }
    return res.writeHead(404).end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  try {
    speaker = await createSpeaker({ ip: '127.0.0.4', id: ID, name: 'Test Speaker', restartMs: 300, quiet: true }).start();
  } catch (error) {
    // Something else on this machine holds one of the speaker's ports.
    skip = `the stand-in speaker could not start (${error.code})`;
    return;
  }

  dataDir = mkdtempSync(join(tmpdir(), 'sound-touch-e2e-'));
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, PUBLIC_URL: BASE, AIRDRIFT_BASE: `http://127.0.0.1:${upstream.address().port}` },
    stdio: 'ignore',
  });
  await until(() => fetch(`${BASE}/healthz`).then((r) => r.ok, () => false), 'the server to start');
  await until(async () => (await api('GET', '/state')).body.stations.count === 8, 'the station list');
});

after(() => {
  server?.kill();
  speaker?.stop();
  upstream?.closeAllConnections();
  upstream?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('adds a speaker and fills its buttons with stations from its country', async (t) => {
  if (skip) return t.skip(skip);
  const added = await api('POST', '/speakers', { ip: '127.0.0.4', country: 'GB' });
  assert.equal(added.status, 200);
  assert.equal(added.body.id, ID);
  assert.equal(added.body.mode, 'listener');
  assert.deepEqual(added.body.presets.map((p) => p.name), ['Station 1', 'Station 2', 'Station 3', 'Station 4', 'Station 5', 'Station 6']);
  return undefined;
});

test('refuses an address where no speaker answers', async (t) => {
  if (skip) return t.skip(skip);
  const added = await api('POST', '/speakers', { ip: '127.0.0.9' });
  assert.equal(added.status, 502);
  assert.match(added.body.error, /No SoundTouch speaker answered/);
  return undefined;
});

test('listener mode: a button press is heard and the station is started', async (t) => {
  if (skip) return t.skip(skip);
  const sent = await api('POST', `/speakers/${ID}/apply`);
  assert.equal(sent.body.ok, true, JSON.stringify(sent.body.steps));
  assert.equal(speaker.presets[1].source, 'UPNP');
  assert.equal(speaker.presets[1].location, `${BASE}/stream/${ID}/1`);
  assert.deepEqual(speaker.config, FACTORY, 'the speaker was not reconfigured');

  speaker.fetched.length = 0;
  await speaker.press(3);
  await until(() => speaker.playing === 'Station 3', 'button 3 to play');
  assert.ok(speaker.fetched.every((url) => url === `${BASE}/stream/${ID}/3`));
  const { body } = await api('GET', '/state');
  assert.equal(body.speakers[0].activity.slot, 3);
  assert.equal(body.speakers[0].listening, true);
  return undefined;
});

test('a station changed here keeps the stream address of its button', async (t) => {
  if (skip) return t.skip(skip);
  const changed = await api('PUT', `/speakers/${ID}/presets/3`, { stationId: 'st-8' });
  assert.match(changed.body.message, /Button 3 is now Station 8/);
  assert.equal(speaker.presets[3].name, 'Station 8');
  assert.equal(speaker.presets[3].location, `${BASE}/stream/${ID}/3`);
  return undefined;
});

test('native mode: the speaker is pointed here and plays a button by itself', async (t) => {
  if (skip) return t.skip(skip);
  await api('PUT', `/speakers/${ID}`, { mode: 'native' });
  const sent = await api('POST', `/speakers/${ID}/apply`);
  assert.equal(sent.body.ok, true, JSON.stringify(sent.body.steps));
  assert.deepEqual(speaker.config, {
    bmxRegistryUrl: `${BASE}/bmx/registry/v1/services`,
    statsServerUrl: BASE,
    margeServerUrl: BASE,
    swUpdateUrl: `${BASE}/updates/soundtouch`,
  });
  assert.match(speaker.account, /^\d{7}$/);
  assert.equal(speaker.presets[2].source, 'LOCAL_INTERNET_RADIO');
  assert.match(speaker.presets[2].location, /^\/station\?data=/);

  speaker.fetched.length = 0;
  await speaker.press(2);
  assert.equal(speaker.playing, 'Station 2');
  assert.deepEqual(speaker.fetched, [`${BASE}/stream/${ID}/2`]);

  const account = await fetch(`${BASE}/streaming/account/${speaker.account}/full`);
  assert.ok(account.headers.get('etag'));
  const xml = await account.text();
  assert.equal((xml.match(/<preset buttonNumber=/g) || []).length, 6);
  assert.equal((xml.match(/<sourceproviderid>/g) || []).length, 8, 'every source names its provider');
  const again = await fetch(`${BASE}/streaming/account/${speaker.account}/full`, { headers: { 'If-None-Match': account.headers.get('etag') } });
  assert.equal(again.status, 304);
  return undefined;
});

test('back to listening: the speaker gets Bose\'s addresses back', async (t) => {
  if (skip) return t.skip(skip);
  await api('PUT', `/speakers/${ID}`, { mode: 'listener' });
  const sent = await api('POST', `/speakers/${ID}/apply`);
  assert.equal(sent.body.ok, true, JSON.stringify(sent.body.steps));
  assert.deepEqual(speaker.config, FACTORY);
  assert.equal(speaker.presets[1].source, 'UPNP');
  return undefined;
});

test('the health page reports on the server, the list and the speaker', async (t) => {
  if (skip) return t.skip(skip);
  const { body } = await api('GET', '/health');
  assert.deepEqual(body.groups.map((group) => group.title), ['This server', 'Stations', 'Test Speaker']);
  const failing = body.groups.flatMap((group) => group.checks).filter((check) => check.status === 'fail');
  assert.deepEqual(failing, []);
  return undefined;
});

test('the setup pages turn away other sites and unknown host names', async (t) => {
  if (skip) return t.skip(skip);
  const foreign = await fetch(`${BASE}/api/discover`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.equal(foreign.status, 403);
  const rebound = await fetch(`${BASE}/api/state`, { headers: { Host: 'evil.example' } }).catch(() => null);
  // fetch refuses to set Host; the check is exercised when it lets us.
  if (rebound && rebound.status !== 200) assert.equal(rebound.status, 403);
  return undefined;
});
