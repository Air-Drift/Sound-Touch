// The health page: one check for each link between a button and a station.
import { accessSync, constants } from 'node:fs';
import { isIP } from 'node:net';
import { config } from './config.mjs';
import * as control from './control.mjs';
import { lanAddresses } from './discovery.mjs';
import * as proxy from './proxy.mjs';
import * as speakerApi from './speaker.mjs';
import * as stations from './stations.mjs';
import { publicUrl, speakers } from './store.mjs';

const ok = (label, detail) => ({ label, detail, status: 'ok' });
const warn = (label, detail) => ({ label, detail, status: 'warn' });
const fail = (label, detail) => ({ label, detail, status: 'fail' });

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'never');

async function serverChecks(instance) {
  const checks = [];
  const url = publicUrl();
  if (!url) {
    checks.push(fail('Server address', 'No address has been chosen yet. Run setup.'));
  } else {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(4_000) });
      const answer = await response.json();
      checks.push(answer.instance === instance
        ? ok('Server address', `${url} reaches this server.`)
        : fail('Server address', `${url} is answered by something else. Speakers are being sent to the wrong place.`));
    } catch (error) {
      checks.push(fail('Server address', `This server cannot reach itself at ${url} (${error.cause?.code || error.message}). Has its address changed?`));
    }
    const host = new URL(url).hostname;
    const mine = lanAddresses().map((entry) => entry.address);
    if (isIP(host) && !mine.includes(host)) {
      checks.push(warn('Network mode', `The container does not hold ${host} itself, so it is on a Docker bridge. Buttons work as long as port ${config.port} is published; finding speakers automatically does not.`));
    } else {
      checks.push(ok('Network mode', 'On the host network, so speakers can be found automatically.'));
    }
  }

  const version = proxy.ffmpeg();
  checks.push(version
    ? ok('Stream converter', version)
    : warn('Stream converter', 'ffmpeg was not found. HLS, Ogg and FLAC stations cannot be played; MP3 and AAC stations still work.'));

  try {
    accessSync(config.dataDir, constants.W_OK);
    checks.push(ok('Storage', `${config.dataDir} is writable.`));
  } catch {
    checks.push(fail('Storage', `${config.dataDir} is not writable. Settings will be lost when the container restarts.`));
  }

  const playing = [...proxy.active.values()];
  checks.push(ok('Playing now', playing.length
    ? playing.map((entry) => `${entry.station} to ${entry.speaker}${entry.via === 'ffmpeg' ? ' (converted)' : ''}`).join('; ')
    : 'Nothing at the moment.'));
  return checks;
}

function stationChecks() {
  const status = stations.status();
  if (!status.count) return [fail('Station list', `No stations have been fetched from ${status.source}${status.lastError ? ` (${status.lastError})` : ''}. Buttons already set up keep working.`)];
  const age = status.lastSync ? Date.now() - Date.parse(status.lastSync) : Infinity;
  const detail = `${status.count.toLocaleString('en-GB')} stations, published ${when(status.generated)}, last checked ${when(status.lastSync)}.`;
  if (status.lastError) return [warn('Station list', `${detail} The last refresh failed: ${status.lastError}`)];
  if (age > config.syncHours * 3 * 3_600_000) return [warn('Station list', `${detail} It has not refreshed for a while.`)];
  return [ok('Station list', detail)];
}

async function speakerChecks(speaker) {
  const checks = [];
  let details = null;
  try {
    details = await speakerApi.info(speaker.ip);
  } catch (error) {
    checks.push(fail('Reachable', `No answer from ${speaker.ip} (${error.cause?.code || error.message}). Is it switched on, and has its address changed?`));
  }
  if (details && details.id !== speaker.id) {
    checks.push(fail('Reachable', `${speaker.ip} is now a different speaker (${details.name}). Remove this one and add it again at its new address.`));
    details = null;
  } else if (details) {
    checks.push(ok('Reachable', `${details.type}, firmware ${details.firmware || 'unknown'}, at ${speaker.ip}.`));
  }

  checks.push(...control.linkChecks(speaker, details).map(([status, label, detail]) => ({ status, label, detail })));

  const filled = speaker.presets.map((station, i) => ({ station, slot: i + 1 })).filter((entry) => entry.station);
  if (!filled.length) checks.push(warn('Stations', 'No button has a station on it.'));
  const probes = await Promise.all(filled.map(({ station }) => proxy.probe(station)));
  filled.forEach(({ station, slot }, i) => {
    const label = `Button ${slot}: ${station.name}`;
    checks.push(probes[i].ok
      ? ok(label, probes[i].via === 'direct' ? `Answering (${probes[i].detail}).` : `Answering, ${probes[i].detail}.`)
      : fail(label, `Not answering: ${probes[i].detail}. Choose another station for this button, or try again later.`));
  });

  const last = control.view(speaker).activity;
  checks.push(last
    ? ok('Last button heard', `Button ${last.slot}, ${when(last.at)}.`)
    : warn('Last button heard', 'No button has been pressed since this server started.'));
  return checks;
}

const worst = (checks) => (checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok');

export async function check(instance) {
  const [server, ...perSpeaker] = await Promise.all([serverChecks(instance), ...speakers().map(speakerChecks)]);
  const groups = [
    { title: 'This server', checks: server },
    { title: 'Stations', checks: stationChecks() },
    ...speakers().map((speaker, i) => ({ title: speaker.name, checks: perSpeaker[i] })),
  ];
  // "No button pressed yet" is information, not a fault.
  const counted = groups.flatMap((group) => group.checks).filter((c) => c.label !== 'Last button heard');
  return { at: new Date().toISOString(), status: worst(counted), groups };
}
