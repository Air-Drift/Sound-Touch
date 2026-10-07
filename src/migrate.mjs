// Telling a speaker which servers to ask. Every SoundTouch has a service
// console on TCP port 17000 that takes one line at a time, with no login. Four
// settings name the servers; `envswitch boseurls set` is what makes them
// survive a restart, so it has to come after the other four.
import { connect } from 'node:net';

export const FACTORY = {
  bmxRegistryUrl: 'https://content.api.bose.io/bmx/registry/v1/services',
  statsServerUrl: 'https://events.api.bosecm.com',
  margeServerUrl: 'https://streaming.bose.com',
  swUpdateUrl: 'https://worldwide.bose.com/updates/soundtouch',
};

const KEYS = Object.keys(FACTORY);
const QUIET = 600;
const REPLY_WAIT = 7_000;

// The values for a speaker that asks this server.
export const urlsFor = (base) => ({
  bmxRegistryUrl: `${base}/bmx/registry/v1/services`,
  statsServerUrl: base,
  margeServerUrl: base,
  swUpdateUrl: `${base}/updates/soundtouch`,
});

// The console hands each line to a shell on the speaker, so nothing but a
// plain address is ever sent to it.
function plain(url) {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._\/-]*)?$/.test(url)) throw new Error(`"${url}" is not an address that can be sent to a speaker`);
  return url;
}

function session(ip) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: ip, port: 17000, timeout: 4_000 });
    let buffer = '';
    let wake = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      wake?.();
    });
    socket.once('timeout', () => socket.destroy(new Error('timed out')));
    socket.once('error', (error) => reject(new Error(`the speaker's service port (17000) did not answer: ${error.code || error.message}. It opens about 90 seconds after the speaker starts.`)));

    // A reply is finished when the speaker has been quiet for a moment.
    const reply = (limit) => new Promise((done) => {
      const deadline = setTimeout(finish, limit);
      let quiet = null;
      function finish() {
        clearTimeout(deadline);
        clearTimeout(quiet);
        wake = null;
        const text = buffer;
        buffer = '';
        done(text);
      }
      wake = () => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, QUIET);
      };
      if (buffer) wake();
    });

    socket.once('connect', async () => {
      socket.setTimeout(0);
      await reply(1_200); // the greeting, which may be nothing
      resolve({
        async send(line) {
          socket.write(`${line}\r\n`);
          const text = await reply(REPLY_WAIT);
          if (/command not found|unknown command|not implemented|invalid command/i.test(text)) {
            throw new Error(`the speaker does not accept "${line.split(' ').slice(0, 2).join(' ')}" on this firmware`);
          }
          return text;
        },
        close: () => socket.destroy(),
      });
    });
  });
}

// `getpdo CurrentSystemConfiguration` prints one block per setting:
//   margeServerUrl {
//     text: "https://streaming.bose.com"
//   }
export function parseConfiguration(text) {
  const found = {};
  for (const match of text.matchAll(/(\w+)\s*\{\s*text:\s*"([^"]*)"/g)) {
    if (KEYS.includes(match[1])) found[match[1]] = match[2];
  }
  return found;
}

export async function read(ip) {
  const console_ = await session(ip);
  try {
    return parseConfiguration(await console_.send('getpdo CurrentSystemConfiguration'));
  } finally {
    console_.close();
  }
}

// Writes the four addresses, confirms the speaker took them, and restarts
// it. Returns what the speaker had before, so it can be put back.
export async function point(ip, urls) {
  for (const key of KEYS) plain(urls[key]);
  const console_ = await session(ip);
  try {
    const before = parseConfiguration(await console_.send('getpdo CurrentSystemConfiguration'));
    for (const key of ['bmxRegistryUrl', 'statsServerUrl', 'margeServerUrl', 'swUpdateUrl']) {
      const answer = await console_.send(`sys configuration ${key} ${urls[key]}`);
      if (!/\bOK\b/i.test(answer)) throw new Error(`the speaker did not accept ${key} (it said "${answer.replace(/->/g, '').trim() || 'nothing'}")`);
    }
    // This one answers with a sentence and not always an OK.
    await console_.send(`envswitch boseurls set ${urls.margeServerUrl} ${urls.swUpdateUrl}`);
    const after = parseConfiguration(await console_.send('getpdo CurrentSystemConfiguration'));
    const wrong = KEYS.filter((key) => after[key] !== urls[key]);
    if (wrong.length) throw new Error(`the speaker did not keep ${wrong.join(', ')}. It has not been restarted; nothing has changed for good.`);
    await console_.send('sys reboot').catch(() => {});
    return before;
  } finally {
    console_.close();
  }
}
