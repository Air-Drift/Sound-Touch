// Finding speakers on the network. SoundTouch speakers answer an SSDP search
// for media renderers; anything that answers is then asked for /info, which
// only a SoundTouch gives. The search is multicast, so it needs the container
// on the host network. Without it nothing answers and the wizard asks for
// the speaker's address instead.
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { info } from './speaker.mjs';

const GROUP = '239.255.255.250';
const SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${GROUP}:1900`,
  'MAN: "ssdp:discover"',
  'MX: 2',
  'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
  '', '',
].join('\r\n');

const bridged = existsSync('/.dockerenv');

// IPv4 addresses this machine has on real networks, most likely LAN first.
// Docker's own bridges are left out: a speaker cannot reach them.
export function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|cni|flannel|tailscale|zt)/.test(name)) continue;
    for (const entry of list || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // Inside a bridged container the only address is the container's own,
      // which nothing outside Docker can reach.
      if (bridged && /^eth\d/.test(name) && /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) continue;
      found.push({ name, address: entry.address });
    }
  }
  const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return found.sort((a, b) => isPrivate(b.address) - isPrivate(a.address));
}

function listen(address, wait) {
  return new Promise((resolve) => {
    const hosts = new Set();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve(hosts);
    };
    socket.on('error', done);
    socket.on('message', (message, remote) => {
      const location = /^location:\s*http:\/\/([\d.]+):(\d+)/im.exec(message.toString());
      hosts.add(location ? location[1] : remote.address);
    });
    socket.bind(0, address, () => {
      const send = () => socket.send(SEARCH, 1900, GROUP, () => {});
      send();
      setTimeout(send, 400).unref();
      setTimeout(done, wait).unref();
    });
  });
}

export async function discover(wait = 3_000) {
  const addresses = lanAddresses().map((entry) => entry.address);
  const answers = await Promise.all(addresses.map((address) => listen(address, wait)));
  const hosts = [...new Set(answers.flatMap((set) => [...set]))];
  const found = await Promise.all(hosts.map((ip) => info(ip).then((details) => ({ ip, ...details }), () => null)));
  const unique = new Map();
  for (const speaker of found) if (speaker) unique.set(speaker.id, speaker);
  return [...unique.values()];
}
