// The whole configuration is one JSON file in the data volume: the server
// address, the speakers and their six stations each.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const file = join(config.dataDir, 'state.json');

const blank = () => ({
  setupComplete: false,
  publicUrl: '',
  speakers: {},
});

function load() {
  mkdirSync(config.dataDir, { recursive: true });
  try {
    return { ...blank(), ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`state: starting fresh, ${file} was unreadable (${error.message})`);
    return blank();
  }
}

export const state = load();

// Written through a temporary file so a crash mid-write leaves the old one.
export function save() {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export const SLOTS = [1, 2, 3, 4, 5, 6];

export const publicUrl = () => config.publicUrl || state.publicUrl || '';

export function speaker(id) {
  return Object.hasOwn(state.speakers, id) ? state.speakers[id] : null;
}

export const speakers = () => Object.values(state.speakers);

export function preset(speakerId, slot) {
  return speaker(speakerId)?.presets?.[Number(slot) - 1] || null;
}

// The address a speaker fetches for one of its buttons. It stays the same
// when the station behind the button changes.
export function streamUrl(speakerId, slot) {
  return `${publicUrl()}/stream/${speakerId}/${slot}`;
}
