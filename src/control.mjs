// Ties the pieces together for one speaker: sending its setup, playing a
// button, and keeping an eye on whether it is there.
//
// A speaker is in one of two modes.
//   listener  Its presets are stored as plain UPnP items. This server hears
//             the button on the speaker's websocket and starts the stream.
//   native    The speaker has been told to ask this server where it asked
//             Bose. Its presets are custom-station items and it plays them
//             itself.
// In both, what the speaker fetches is this server's address for the button.
import * as cloud from './bose/cloud.mjs';
import * as listener from './listener.mjs';
import * as migrate from './migrate.mjs';
import * as speakerApi from './speaker.mjs';
import * as stations from './stations.mjs';
import { SLOTS, publicUrl, save, speakers, state, streamUrl } from './store.mjs';
import * as upnp from './upnp.mjs';

const LOOK_EVERY = 20_000;
const RESTART_WAIT = 180_000;

const live = new Map(); // what was last seen of each speaker
const activity = new Map(); // the last button each speaker asked to play
const busy = new Set();
let timer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mime = (station) => (/^AAC/i.test(station.codec || '') ? 'audio/aac' : 'audio/mpeg');

export const snapshot = (station) => {
  const { id, name, url, country, codec, bitrate, hls, icon } = station;
  return { id, name, url, country, codec, bitrate, hls, icon };
};

// Six stations to start a new speaker off with: the most played in the
// listener's own country where the list has that many, otherwise the most
// played anywhere.
export function defaults(country = '') {
  const local = /^[A-Za-z]{2}$/.test(country) ? stations.search({ country, limit: 6 }).stations : [];
  const six = local.length === 6 ? local : stations.popular(6);
  return six.map(snapshot).concat(Array(6).fill(null)).slice(0, 6);
}

export function view(speaker) {
  const seen = live.get(speaker.id) || {};
  return {
    id: speaker.id,
    name: speaker.name,
    type: speaker.type,
    firmware: speaker.firmware,
    ip: speaker.ip,
    mode: speaker.mode,
    applied: Boolean(speaker.appliedAt),
    presets: speaker.presets.map((station) => station && { ...station, transcode: stations.needsTranscode(station) }),
    online: Boolean(seen.online),
    listening: listener.listening(speaker.id),
    migrated: Boolean(seen.margeUrl) && seen.margeUrl === publicUrl(),
    nowPlaying: seen.nowPlaying || null,
    activity: activity.get(speaker.id) || null,
  };
}

export const heard = (id, slot) => activity.set(id, { slot, at: new Date().toISOString() });

// How a button is written onto the speaker in each mode.
function item(speaker, slot) {
  const station = speaker.presets[slot - 1];
  if (speaker.mode === 'native') {
    return { source: 'LOCAL_INTERNET_RADIO', type: 'stationurl', location: cloud.location(speaker, slot), sourceAccount: '', name: station.name, art: station.icon };
  }
  // No artwork here: the speaker refuses a UPnP preset that carries any.
  return { source: 'UPNP', location: streamUrl(speaker.id, slot), sourceAccount: 'UPnPUserName', name: station.name };
}

export async function play(speaker, slot) {
  const station = speaker.presets[slot - 1];
  if (speaker.mode === 'native') await speakerApi.select(speaker.ip, item(speaker, slot));
  else await upnp.play(speaker, { url: streamUrl(speaker.id, slot), title: station.name, art: station.icon, mime: mime(station) });
}

function listen(speaker) {
  listener.watch(speaker, (slot) => {
    if (!speaker.presets[slot - 1]) return;
    console.log(`${speaker.name}: button ${slot}, ${speaker.presets[slot - 1].name}`);
    play(speaker, slot).catch((error) => console.warn(`${speaker.name}: button ${slot} did not start: ${error.message}`));
  });
}

async function look(speaker) {
  const before = live.get(speaker.id) || {};
  try {
    const details = await speakerApi.info(speaker.ip);
    if (details.id !== speaker.id) throw new Error('a different speaker answered');
    const nowPlaying = await speakerApi.nowPlaying(speaker.ip).catch(() => null);
    live.set(speaker.id, { online: true, margeUrl: details.margeUrl, nowPlaying: nowPlaying?.status === 'PLAY_STATE' ? nowPlaying : null });
    // Back after being away: the old connection is dead whatever it says.
    if (!before.online && speaker.mode === 'listener' && speaker.appliedAt) listener.renew(speaker.id);
    return details;
  } catch {
    live.set(speaker.id, { online: false, margeUrl: before.margeUrl });
    return null;
  }
}

// Waits for a restarted speaker to answer again and to satisfy `ready`.
async function back(speaker, ready) {
  const until = Date.now() + RESTART_WAIT;
  await sleep(10_000);
  while (Date.now() < until) {
    const details = await look(speaker);
    if (details && ready(details)) return details;
    await sleep(5_000);
  }
  throw new Error('the speaker did not come back within three minutes. Check it has power, then send the setup again.');
}

async function storeAll(speaker) {
  const filled = SLOTS.filter((slot) => speaker.presets[slot - 1]);
  let failure = null;
  // After a restart the radio source takes a little while to appear, and
  // the speaker refuses the presets until it has.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      for (const slot of filled) await speakerApi.storePreset(speaker.ip, slot, item(speaker, slot));
      return filled.length;
    } catch (error) {
      failure = error;
      await sleep(6_000);
    }
  }
  throw failure;
}

// Sends a speaker everything it needs for its mode. Each step is reported,
// and the first one that fails ends the run.
export async function apply(speaker) {
  const steps = [];
  const done = (label, detail = '') => steps.push({ label, ok: true, detail });
  if (busy.has(speaker.id)) return { steps: [{ label: 'Already working on this speaker', ok: false, detail: 'Wait for the first run to finish.' }] };
  const base = publicUrl();
  if (!base) return { steps: [{ label: 'Server address', ok: false, detail: 'Choose the address speakers will use first (step 2 of setup).' }] };

  busy.add(speaker.id);
  let doing = 'Reach the speaker';
  try {
    let details = await speakerApi.info(speaker.ip).catch((error) => {
      throw new Error(`no answer at ${speaker.ip} (${error.cause?.code || error.message})`);
    });
    if (details.id !== speaker.id) throw new Error(`${speaker.ip} is now a different speaker (${details.name})`);
    Object.assign(speaker, { name: details.name, type: details.type, firmware: details.firmware, serial: details.serial, addedAt: speaker.addedAt || new Date().toISOString() });
    done(doing, `${details.type}, firmware ${details.firmware.split(' ')[0] || 'unknown'}`);

    if (speaker.mode === 'native') {
      // The speaker asks for its account as it starts, so the account has
      // to be known here before it is restarted.
      speaker.account = details.account || speaker.account || String(Math.floor(1_000_000 + Math.random() * 9_000_000));
      save();
      if (details.margeUrl !== base) {
        doing = 'Point the speaker at this server';
        const before = await migrate.point(speaker.ip, migrate.urlsFor(base));
        if (!speaker.original && before.margeServerUrl && !before.margeServerUrl.startsWith(base)) speaker.original = before;
        save();
        done(doing, 'Accepted. The speaker is restarting.');
        doing = 'Wait for the speaker to restart';
        details = await back(speaker, (now) => now.margeUrl === base);
        done(doing, 'It is back and asking this server.');
      } else {
        done('Point the speaker at this server', 'Already done.');
      }
      if (!details.account) {
        doing = 'Give the speaker an account';
        await speakerApi.pair(speaker.ip, speaker.account);
        done(doing);
      }
      listener.unwatch(speaker.id);
    } else if (details.margeUrl === base) {
      doing = 'Return the speaker to Bose\'s addresses';
      await migrate.point(speaker.ip, { ...migrate.FACTORY, ...speaker.original });
      done(doing, 'Accepted. The speaker is restarting.');
      doing = 'Wait for the speaker to restart';
      await back(speaker, (now) => now.margeUrl !== base);
      delete speaker.original;
      save();
      done(doing);
    }

    doing = 'Store the stations on the buttons';
    const count = await storeAll(speaker);
    done(doing, count ? `${count} button${count === 1 ? '' : 's'} set.` : 'No button has a station yet.');

    if (speaker.mode === 'listener') {
      listen(speaker);
      done('Listen for the buttons', 'Connected to the speaker.');
    }
    speaker.appliedAt = new Date().toISOString();
    save();
    await look(speaker);
  } catch (error) {
    steps.push({ label: doing, ok: false, detail: error.message });
  } finally {
    busy.delete(speaker.id);
  }
  return { ok: steps.every((entry) => entry.ok), steps };
}

// One button changed in the setup pages. The stream address has not, so the
// button already plays the new station; this only updates the name the
// speaker shows. Returns a few words to add to the confirmation.
export async function slotChanged(speaker, slot) {
  if (!speaker.appliedAt || !speaker.presets[slot - 1]) return '';
  try {
    await speakerApi.storePreset(speaker.ip, slot, item(speaker, slot));
    return '';
  } catch {
    return '. The speaker did not answer, so its display will show the old name until it does';
  }
}

export async function adopt(speaker) {
  speaker.addedAt ||= new Date().toISOString();
  save();
  await look(speaker);
}

export function forget(speaker) {
  listener.unwatch(speaker.id);
  live.delete(speaker.id);
  activity.delete(speaker.id);
}

// After the station list refreshes: follow stations whose stream has moved,
// and fill in a speaker that was added before the list had arrived.
export function refreshStations() {
  let changed = false;
  for (const speaker of speakers()) {
    if (!state.setupComplete && speaker.presets.every((station) => !station)) {
      speaker.presets = defaults(speaker.country);
      changed = true;
    }
    speaker.presets.forEach((station, i) => {
      const current = station && !station.custom && stations.byId(station.id);
      if (current && current.url !== station.url) {
        speaker.presets[i] = snapshot(current);
        changed = true;
      }
    });
  }
  if (changed) save();
}

// The speaker-specific lines on the health page: [status, label, detail].
export function linkChecks(speaker, details) {
  const base = publicUrl();
  if (!speaker.appliedAt) return [['warn', 'Buttons', 'The setup has not been sent to this speaker yet.']];
  if (speaker.mode === 'listener') {
    const checks = [listener.listening(speaker.id)
      ? ['ok', 'Buttons', 'Connected to the speaker and listening for presses.']
      : ['fail', 'Buttons', 'Not connected to the speaker, so presses are not heard. It reconnects by itself once the speaker answers.']];
    if (details?.margeUrl === base) checks.push(['warn', 'Speaker settings', 'The speaker is still pointed at this server from before. Send its setup again to tidy that up.']);
    return checks;
  }
  const checks = [];
  if (details) {
    checks.push(details.margeUrl === base
      ? ['ok', 'Speaker settings', 'The speaker asks this server where it used to ask Bose.']
      : ['fail', 'Speaker settings', `The speaker is asking ${details.margeUrl || 'nobody'}, not ${base}. Send its setup again.`]);
    checks.push(details.account
      ? ['ok', 'Account', 'The speaker has an account, which it needs for radio.']
      : ['fail', 'Account', 'The speaker has no account, so it will not play radio. Send its setup again.']);
  }
  const seen = cloud.lastSeen(speaker.id);
  checks.push(seen
    ? ['ok', 'Check-in', `The speaker last asked this server something at ${new Date(seen).toISOString().slice(11, 16)} UTC.`]
    : ['warn', 'Check-in', 'The speaker has not asked this server anything since it started. It does so when it starts and every few minutes.']);
  return checks;
}

export function start() {
  for (const speaker of speakers()) if (speaker.mode === 'listener' && speaker.appliedAt) listen(speaker);
  const round = () => Promise.all(speakers().map(look));
  round();
  timer = setInterval(round, LOOK_EVERY);
  timer.unref();
}

export function stop() {
  clearInterval(timer);
  listener.stopAll();
}
