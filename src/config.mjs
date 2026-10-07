// Everything the container can be told from outside. The wizard covers the
// rest and keeps it in the data volume.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const env = process.env;

const number = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  version: pkg.version,
  port: number(env.PORT, 8686),
  dataDir: env.DATA_DIR || '/data',
  webDir: fileURLToPath(new URL('../web/', import.meta.url)),
  // The address speakers use to reach this server, e.g. http://192.168.1.20:8686.
  // Normally chosen in the wizard; set it here to pin it.
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Extra hostnames the admin pages may be opened under (comma separated).
  allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  airdriftBase: (env.AIRDRIFT_BASE || 'https://airdrift.stream/data/v1').replace(/\/+$/, ''),
  syncHours: number(env.SYNC_INTERVAL_HOURS, 24),
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  mp3Bitrate: number(env.MP3_BITRATE, 192),
  userAgent: `AirDriftSoundTouch/${pkg.version} (+https://github.com/Air-Drift/Sound-Touch)`,
};
