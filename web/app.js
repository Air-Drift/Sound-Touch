// The setup wizard, the speakers page and the health page. One file, no
// framework: each view is a function that returns HTML, and clicks are routed
// by a data-do attribute.

const app = document.getElementById('app');
const picker = document.getElementById('picker');
const preview = document.getElementById('preview');
const toastEl = document.getElementById('toast');

const STEPS = ['Welcome', 'Server address', 'Speakers', 'Buttons', 'Stations', 'Finish'];

let S = null; // what the server says
const ui = {
  found: null, // speakers the last search turned up
  searching: false,
  addressNote: null,
  results: {}, // per speaker: the outcome of sending its setup
  busy: {},
  health: null,
  pick: null, // the open station picker
  facets: null,
  playing: null,
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const regions = new Intl.DisplayNames([navigator.language || 'en'], { type: 'region' });
const countryName = (code) => {
  try { return regions.of(code) || code; } catch { return code || ''; }
};

async function api(method, path, body) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server answered ${response.status}`);
  return data;
}

let toastTimer;
function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, bad ? 6000 : 3000);
}

async function refresh() {
  S = await api('GET', '/state');
  document.getElementById('version').textContent = `Version ${S.version}.`;
  return S;
}

// Runs a server call with a button's busy state around it.
async function during(key, work) {
  ui.busy[key] = true;
  render();
  try {
    return await work();
  } catch (error) {
    toast(error.message, true);
    return null;
  } finally {
    delete ui.busy[key];
    render();
  }
}

/* ---------- pieces ---------- */

const ago = (iso) => {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
};

function stationSub(station) {
  const parts = [];
  if (station.country) parts.push(countryName(station.country));
  if (station.codec) parts.push(`${station.codec}${station.bitrate ? ` ${station.bitrate}k` : ''}`);
  if (station.custom) parts.push('your own stream');
  if (station.transcode) parts.push('converted');
  return parts.join(' · ');
}

// Station artwork, as airdrift.stream draws it: the station's initials on a
// tint worked out from its id, with the logo laid over the top when it has
// one that loads. The same station gets the same tile everywhere.
function initials(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function hueFor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function art(station) {
  // Custom streams have a random id, so they are tinted by name.
  const hue = hueFor(String((!station.custom && station.id) || station.name || ''));
  const logo = station.icon ? `<img src="${esc(station.icon)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
  return `<span class="art" style="--hue:${hue}" aria-hidden="true">${esc(initials(station.name))}${logo}</span>`;
}

function playButton(src, label) {
  const on = ui.playing === src;
  const icon = on ? '<rect x="2" y="2" width="10" height="10" rx="1"/>' : '<path d="M3 1.5v11l9-5.5z"/>';
  return `<button class="play" type="button" data-do="preview" data-src="${esc(src)}" aria-pressed="${on}" aria-label="${on ? 'Stop' : 'Listen to'} ${esc(label)} here">
    <svg viewBox="0 0 14 14" aria-hidden="true">${icon}</svg></button>`;
}

const heard = (speaker, slot) => speaker.activity?.slot === slot && Date.now() - Date.parse(speaker.activity.at) < 20_000;

function slots(speaker, { play = false } = {}) {
  return `<ol class="slots">${speaker.presets.map((station, i) => {
    const slot = i + 1;
    const body = station
      ? `${art(station)}<div class="grow"><div class="slot-name clip">${esc(station.name)}</div><div class="slot-sub clip">${esc(stationSub(station))}</div></div>`
      : '<div class="grow slot-empty">Nothing on this button</div>';
    const listen = station ? playButton(`/preview/${speaker.id}/${slot}`, station.name) : '';
    const send = play && station ? `<button class="btn sm" type="button" data-do="play" data-id="${speaker.id}" data-slot="${slot}">Play</button>` : '';
    return `<li class="slot${heard(speaker, slot) ? ' heard' : ''}">
      <span class="slot-key" aria-label="Button ${slot}">${slot}</span>${body}
      <span class="slot-actions">${listen}${send}
        <button class="btn sm" type="button" data-do="pick" data-id="${speaker.id}" data-slot="${slot}">${station ? 'Change' : 'Choose'}</button></span>
    </li>`;
  }).join('')}</ol>`;
}

// A speaker's six buttons as a keypad. The key last pressed on the speaker
// is lit, and pressing one here plays it on the speaker.
function keypad(speaker) {
  return `<div class="keys sm" role="group" aria-label="Preset buttons on ${esc(speaker.name)}">${speaker.presets.map((station, i) => {
    const slot = i + 1;
    const label = station ? `Play button ${slot}, ${station.name}, on ${speaker.name}` : `Button ${slot} is empty`;
    return `<button class="key${heard(speaker, slot) ? ' lit' : ''}" type="button" data-do="play" data-id="${speaker.id}" data-slot="${slot}" title="${esc(station ? station.name : 'Empty')}" aria-label="${esc(label)}" ${station ? '' : 'disabled'}>${slot}</button>`;
  }).join('')}</div>`;
}

const speakerMeta = (speaker) => [speaker.type, speaker.ip, speaker.firmware && `firmware ${speaker.firmware.split(' ')[0]}`].filter(Boolean).join(' · ');

function resultList(result) {
  if (!result) return '';
  return `<ul class="results">${result.steps.map((step) => `<li><span class="dot ${step.ok ? 'ok' : 'fail'}"></span>
    <span><strong>${esc(step.label)}</strong>${step.detail ? ` <span class="muted">${esc(step.detail)}</span>` : ''}</span></li>`).join('')}</ul>`;
}

/* ---------- wizard ---------- */

function frame(step, title, lede, body, { next = 'Continue', nextDo = 'next', canNext = true, back = true, aside = '' } = {}) {
  return `
    <ol class="steps" aria-label="Step ${step} of ${STEPS.length}: ${STEPS[step - 1]}">
      ${STEPS.map((_, i) => `<li class="${i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''}"></li>`).join('')}
    </ol>
    <div class="step-head${aside ? ' hero' : ''}">
      <div>
        <p class="eyebrow">Step ${step} of ${STEPS.length} · ${STEPS[step - 1]}</p>
        <h1>${title}</h1>
        ${lede ? `<p class="lede">${lede}</p>` : ''}
      </div>
      ${aside}
    </div>
    ${body}
    <div class="step-foot">
      ${back && step > 1 ? `<a class="btn quiet" href="#/setup/${step - 1}">Back</a>` : '<span></span>'}
      <button class="btn primary" type="button" data-do="${nextDo}" data-step="${step}" ${canNext && !ui.busy.next ? '' : 'disabled'}>${ui.busy.next ? 'Working…' : next}</button>
    </div>`;
}

function stepWelcome() {
  return frame(1, 'Your six buttons, playing again.',
    'Bose switched off the SoundTouch cloud in May 2026, and the preset buttons on the speakers went quiet with it. This puts a small server on your own network that answers those buttons, with any station from Air Drift behind each one.',
    `<div class="card">
       <h2>What you need</h2>
       <ul class="stack small" style="margin:12px 0 0;padding-left:20px;color:var(--ink-200)">
         <li>A SoundTouch speaker that is already on your Wi-Fi or wired network.</li>
         <li>This server left running on the same network. The buttons only work while it is on.</li>
         <li>About five minutes.</li>
       </ul>
     </div>
     <p class="note" style="margin-top:16px">Nothing leaves your network except the request for the station list from airdrift.stream and the radio streams themselves. There is no account and nothing to sign in to.</p>`,
    { next: 'Get started', back: false, aside: `<div class="keys" aria-hidden="true">${[1, 2, 3, 4, 5, 6].map((n) => `<span class="key${n === 1 ? ' lit' : ''}">${n}</span>`).join('')}</div>` });
}

function addressChoices() {
  const here = location.origin;
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const list = S.addresses.map((entry) => ({ url: `http://${entry.address}:${S.port}`, hint: `this machine's address on ${entry.name}` }));
  if (!local && location.protocol === 'http:' && !list.some((entry) => entry.url === here)) {
    list.unshift({ url: here, hint: 'the address you are using right now' });
  }
  return list;
}

function stepAddress() {
  const choices = addressChoices();
  const current = S.publicUrl || choices[0]?.url || '';
  const listed = choices.some((choice) => choice.url === current);
  const body = S.publicUrlPinned
    ? `<div class="card"><h2>Set by the container</h2><p class="muted">PUBLIC_URL is set to <code>${esc(S.publicUrl)}</code>, so speakers will use that.</p></div>`
    : `<div class="card">
        <h2>Where speakers will find this server</h2>
        <p class="muted small">Pick the address on the same network as your speakers.</p>
        <div class="choices" style="margin-top:16px">
          ${choices.map((choice) => `<label class="choice"><input type="radio" name="address" value="${esc(choice.url)}" ${choice.url === current ? 'checked' : ''}>
            <strong class="mono">${esc(choice.url)}</strong><span>${esc(choice.hint)}</span></label>`).join('')}
          <label class="choice"><input type="radio" name="address" value="" ${listed ? '' : 'checked'}>
            <strong>A different address or name</strong>
            <span><input type="url" id="address-own" placeholder="http://192.168.1.20:${S.port}" value="${listed ? '' : esc(current)}" aria-label="Server address"></span></label>
        </div>
      </div>`;
  const note = ui.addressNote ? `<p class="note ${ui.addressNote.ok ? 'good' : 'warn'}" style="margin-top:16px">${esc(ui.addressNote.text)}</p>` : '';
  return frame(2, 'Give this server a fixed address.',
    'Each speaker is told one address to ask when a button is pressed. If that address changes later, the buttons stop until you run setup again, so it is worth pinning down now.',
    `${body}${note}
     <div class="card stack">
       <h2>Keep it from moving</h2>
       <p class="small" style="color:var(--ink-200)">In your router, find this machine in the list of connected devices and reserve its address (often called a DHCP reservation or static lease). That is the one network change this needs.</p>
       <details class="more">
         <summary>Do I need a DNS name?</summary>
         <p class="small" style="color:var(--ink-200)">No. A plain address works and is the most reliable choice. A name such as <code>soundtouch.home</code> is only worth it if you expect to move the server to another machine:</p>
         <ol class="small">
           <li>Add a local DNS record on your router, Pi-hole or AdGuard Home that points the name at this machine.</li>
           <li>Check the speakers get their DNS from that same router or resolver. Most do, through DHCP.</li>
           <li>Choose "A different address or name" above and enter <code>http://your-name:${S.port}</code>.</li>
         </ol>
       </details>
       <details class="more">
         <summary>Do I need a certificate?</summary>
         <p class="small" style="color:var(--ink-200)">No, and one would not help. The speakers only trust certificates from public authorities for Bose's own names, so they talk to this server over plain HTTP inside your network. Keep that port reachable from the speakers.</p>
         <p class="small" style="color:var(--ink-200);margin-top:8px">If you want these setup pages behind HTTPS, put your usual reverse proxy in front of them and list its name in <code>ALLOWED_HOSTS</code>. The speakers must still reach the plain <code>http://</code> address chosen above. Do not expose either to the internet: there is no login.</p>
       </details>
     </div>`,
    { nextDo: 'save-address' });
}

function foundList() {
  if (ui.searching) return '<p class="muted">Looking for speakers…</p>';
  if (!ui.found) return '';
  const fresh = ui.found.filter((speaker) => !S.speakers.some((known) => known.id === speaker.id));
  if (!ui.found.length) {
    return `<p class="note warn">No speakers answered. That is normal when the container is not on the host network (Docker Desktop on Mac and Windows cannot do it). Add each speaker by its address below instead.</p>`;
  }
  if (!fresh.length) return '<p class="muted small">Every speaker that answered is already added.</p>';
  return fresh.map((speaker) => `<div class="speaker-row">
      <div class="grow"><strong>${esc(speaker.name)}</strong><div class="speaker-meta">${esc(speakerMeta(speaker))}</div></div>
      <button class="btn sm primary" type="button" data-do="add" data-ip="${esc(speaker.ip)}">Add</button>
    </div>`).join('');
}

function stepSpeakers() {
  const added = S.speakers.length
    ? S.speakers.map((speaker) => `<div class="speaker-row">
        <span class="dot ${speaker.online ? 'ok' : 'fail'}" title="${speaker.online ? 'Answering' : 'Not answering'}"></span>
        <div class="grow"><strong>${esc(speaker.name)}</strong><div class="speaker-meta">${esc(speakerMeta(speaker))}</div></div>
        <button class="btn sm quiet danger" type="button" data-do="remove" data-id="${speaker.id}">Remove</button>
      </div>`).join('')
    : '<p class="muted">None yet.</p>';
  return frame(3, 'Find your speakers.',
    'Speakers on this network are listed here. Add the ones whose buttons you want back.',
    `<div class="card">
       <div class="row"><h2 class="grow">On your network</h2>
         <button class="btn sm" type="button" data-do="discover" ${ui.searching ? 'disabled' : ''}>Search again</button></div>
       <div style="margin-top:12px">${foundList()}</div>
       <form class="row" data-form="add-ip" style="margin-top:16px;align-items:flex-end">
         <label class="field grow"><span>Add by address</span>
           <input type="text" name="ip" inputmode="decimal" placeholder="192.168.1.50" autocomplete="off" required></label>
         <button class="btn" type="submit" ${ui.busy.add ? 'disabled' : ''}>${ui.busy.add ? 'Checking…' : 'Add'}</button>
       </form>
       <p class="muted small" style="margin-top:8px">A speaker's address is in your router's device list, or in the SoundTouch app under Settings, About.</p>
     </div>
     <div class="card"><h2>Added</h2><div style="margin-top:12px">${added}</div></div>
     <p class="note" style="margin-top:16px">Reserve each speaker's address in your router too. This server reaches speakers by address.</p>`,
    { canNext: S.speakers.length > 0 });
}

function stepMode() {
  const cards = S.speakers.map((speaker) => `<div class="card">
      <h2>${esc(speaker.name)}</h2><p class="speaker-meta">${esc(speakerMeta(speaker))}</p>
      <div class="choices two" style="margin-top:16px">
        <label class="choice"><input type="radio" name="mode-${speaker.id}" data-change="mode" data-id="${speaker.id}" value="listener" ${speaker.mode === 'listener' ? 'checked' : ''}>
          <strong>Listen for the buttons</strong>
          <span>The server watches the speaker and starts the station when a button is pressed.</span>
          <ul><li>Nothing on the speaker is changed.</li><li>The speaker's display shows less about the station.</li></ul></label>
        <label class="choice"><input type="radio" name="mode-${speaker.id}" data-change="mode" data-id="${speaker.id}" value="native" ${speaker.mode === 'native' ? 'checked' : ''}>
          <strong>Take over from Bose</strong>
          <span>The speaker is told to ask this server where it used to ask Bose, so the buttons work the way they were built to.</span>
          <ul><li>Changes a setting on the speaker and restarts it. You can undo it here at any time.</li><li>All six buttons belong to this server; presets for other services are dropped.</li></ul></label>
      </div>
    </div>`).join('');
  return frame(4, 'Choose how the buttons work.',
    'There are two ways to do this. Listening is the safe place to start, and you can switch a speaker over later from its page.',
    `${cards}<p class="note" style="margin-top:16px">Either way the buttons need this server to be running. If it is off, pressing a button does nothing.</p>`);
}

function stepStations() {
  const cards = S.speakers.map((speaker, i) => `<div class="card">
      <div class="row"><div class="grow"><h2>${esc(speaker.name)}</h2><p class="speaker-meta">${esc(speaker.type)}</p></div>
        ${S.speakers.length > 1 && i === 0 ? `<button class="btn sm" type="button" data-do="copy" data-id="${speaker.id}">Use these six on every speaker</button>` : ''}</div>
      ${slots(speaker)}
    </div>`).join('');
  const directory = S.stations.count
    ? `<p class="muted small" style="margin-top:16px">${S.stations.count.toLocaleString()} stations from airdrift.stream, updated ${ago(S.stations.generated)}. Searching happens on this server.</p>`
    : `<p class="note bad" style="margin-top:16px">The station list has not arrived yet${S.stations.lastError ? ` (${esc(S.stations.lastError)})` : ''}. You can still enter your own stream addresses.</p>`;
  return frame(5, 'Put a station on each button.',
    'The six most played stations in your country on Air Drift are filled in to start with. Change any of them: search by name, or narrow by country and genre.',
    `${cards}${directory}`);
}

function stepFinish() {
  const done = S.speakers.length > 0 && S.speakers.every((speaker) => ui.results[speaker.id]);
  const cards = S.speakers.map((speaker) => `<div class="card">
      <div class="card-head"><div class="grow"><h2>${esc(speaker.name)}</h2>
        <p class="speaker-meta">${speaker.mode === 'native' ? 'Taking over from Bose' : 'Listening for the buttons'}</p>
        ${ui.results[speaker.id] ? `<p style="margin-top:10px"><button class="btn sm" type="button" data-do="apply" data-id="${speaker.id}" ${ui.busy[speaker.id] ? 'disabled' : ''}>Send again</button></p>` : ''}</div>
        ${ui.results[speaker.id] ? keypad(speaker) : ''}</div>
      ${ui.busy[speaker.id] ? '<p class="muted" style="margin-top:12px">Setting up. A speaker that restarts takes about a minute…</p>' : resultList(ui.results[speaker.id])}
      ${ui.results[speaker.id] ? slots(speaker, { play: true }) : ''}
    </div>`).join('');
  const prompt = done
    ? '<p class="note good" style="margin-top:16px">Now press a preset button on the speaker. The button lights up here when this server hears it.</p>'
    : '';
  return frame(6, done ? 'Press a button.' : 'Send it to the speakers.',
    done ? 'The speakers are set up. Try the buttons before you finish.' : 'This stores the six stations on each speaker and connects the buttons to this server.',
    `${done ? '' : `<p style="margin-bottom:16px"><button class="btn primary" type="button" data-do="apply-all" ${Object.keys(ui.busy).length ? 'disabled' : ''}>Set up ${S.speakers.length === 1 ? 'the speaker' : `${S.speakers.length} speakers`}</button></p>`}
     ${cards}${prompt}`,
    { next: 'Finish', nextDo: 'finish', canNext: done });
}

/* ---------- speakers page ---------- */

function speakerCard(speaker) {
  const badges = [
    `<span class="badge ${speaker.online ? 'ok' : 'fail'}"><span class="dot ${speaker.online ? 'ok' : 'fail'}"></span>${speaker.online ? 'Online' : 'Not answering'}</span>`,
    `<span class="badge">${speaker.mode === 'native' ? 'Takes over from Bose' : 'Listening'}</span>`,
  ];
  if (speaker.mode === 'listener') badges.push(`<span class="badge ${speaker.listening ? 'ok' : 'warn'}">${speaker.listening ? 'Connected' : 'Not connected'}</span>`);
  if (speaker.mode === 'native') badges.push(`<span class="badge ${speaker.migrated ? 'ok' : 'warn'}">${speaker.migrated ? 'Pointed here' : 'Not pointed here yet'}</span>`);
  const now = speaker.nowPlaying?.station ? `<p class="small muted" style="margin-top:8px">Playing ${esc(speaker.nowPlaying.station)}</p>` : '';
  const other = speaker.mode === 'native' ? 'listener' : 'native';
  return `<div class="card">
    <div class="card-head"><div class="grow"><h2>${esc(speaker.name)}</h2><p class="speaker-meta">${esc(speakerMeta(speaker))}</p>
      <div class="row" style="margin-top:10px;gap:8px">${badges.join('')}</div></div>
      ${keypad(speaker)}</div>
    ${now}
    ${slots(speaker, { play: true })}
    ${ui.busy[speaker.id] ? '<p class="muted" style="margin-top:12px">Working. A speaker that restarts takes about a minute…</p>' : resultList(ui.results[speaker.id])}
    <div class="row" style="margin-top:16px">
      <button class="btn sm" type="button" data-do="apply" data-id="${speaker.id}" ${ui.busy[speaker.id] ? 'disabled' : ''}>Send setup to speaker again</button>
      <button class="btn sm" type="button" data-do="switch" data-id="${speaker.id}" data-mode="${other}" ${ui.busy[speaker.id] ? 'disabled' : ''}>${other === 'native' ? 'Take over from Bose' : 'Go back to listening'}</button>
      <span class="grow"></span>
      <button class="btn sm quiet danger" type="button" data-do="remove" data-id="${speaker.id}">Remove</button>
    </div>
  </div>`;
}

function pageSpeakers() {
  return `<div class="step-head"><p class="eyebrow">Speakers</p><h1>Your buttons.</h1>
      <p class="lede">Change what a button plays here. It takes effect the next time the button is pressed.</p></div>
    ${S.speakers.map(speakerCard).join('') || '<p class="note">No speakers yet.</p>'}
    <p style="margin-top:20px"><a class="btn" href="#/setup/3">Add a speaker</a></p>`;
}

/* ---------- health ---------- */

function pageHealth() {
  const groups = ui.health
    ? ui.health.groups.map((group) => `<div class="card"><h2>${esc(group.title)}</h2>
        <ul class="checks">${group.checks.map((check) => `<li class="check"><span class="dot ${check.status}"></span>
          <div class="grow"><div class="check-label">${esc(check.label)}</div><div class="check-detail">${esc(check.detail)}</div></div>
          <span class="badge ${check.status}">${{ ok: 'OK', warn: 'Check', fail: 'Problem' }[check.status]}</span></li>`).join('')}</ul></div>`).join('')
    : '<p class="muted">Running the checks…</p>';
  const summary = ui.health
    ? `<p class="note ${ui.health.status === 'ok' ? 'good' : ui.health.status === 'warn' ? 'warn' : 'bad'}" style="margin-bottom:16px">${
      { ok: 'Everything checks out.', warn: 'Working, with something worth a look.', fail: 'Something is stopping the buttons from working.' }[ui.health.status]} <span class="muted">Checked ${ago(ui.health.at)}.</span></p>`
    : '';
  return `<div class="step-head"><p class="eyebrow">Health</p><h1>Is everything working?</h1>
      <p class="lede">Each check looks at one link in the chain between a button and a station.</p></div>
    ${summary}${groups}
    <div class="row" style="margin-top:20px">
      <button class="btn primary" type="button" data-do="health" ${ui.busy.health ? 'disabled' : ''}>${ui.busy.health ? 'Checking…' : 'Check again'}</button>
      <button class="btn" type="button" data-do="sync" ${ui.busy.sync ? 'disabled' : ''}>${ui.busy.sync ? 'Fetching…' : 'Refresh the station list'}</button>
    </div>`;
}

/* ---------- station picker ---------- */

function pickerShell() {
  const { speaker, slot } = ui.pick;
  const options = (list, label, current, name) => `<select data-pick="${name}" aria-label="${label}">
      <option value="">${label}</option>
      ${list.map((entry) => `<option value="${esc(entry.value)}" ${entry.value === current ? 'selected' : ''}>${esc(name === 'country' ? countryName(entry.value) : entry.value)} (${entry.count.toLocaleString()})</option>`).join('')}
    </select>`;
  const countries = [...(ui.facets?.countries || [])].sort((a, b) => countryName(a.value).localeCompare(countryName(b.value)));
  picker.innerHTML = `
    <div class="picker-head">
      <div class="row"><h2 id="picker-title" class="grow">Button ${slot} on ${esc(speaker.name)}</h2>
        <button class="btn sm quiet" type="button" data-do="close-picker">Close</button></div>
      <div class="picker-filters">
        <input type="search" data-pick="q" placeholder="Search stations" aria-label="Search stations" value="${esc(ui.pick.q)}" autocomplete="off">
        ${options(countries, 'Any country', ui.pick.country, 'country')}
        ${options(ui.facets?.genres || [], 'Any genre', ui.pick.genre, 'genre')}
      </div>
    </div>
    <ul class="picker-list" id="picker-list"></ul>
    <details class="more" style="margin:0 20px">
      <summary>Use my own stream address</summary>
      <form class="picker-own" data-form="own" style="padding:0 0 12px">
        <label class="field"><span>Name</span><input type="text" name="name" required maxlength="90"></label>
        <label class="field"><span>Stream address</span><input type="url" name="url" required placeholder="https://"></label>
        <button class="btn" type="submit">Use it</button>
      </form>
    </details>
    <div class="picker-foot"><span class="muted small" id="picker-count"></span>
      <span class="row"><button class="btn sm quiet danger" type="button" data-do="clear-slot">Leave this button empty</button>
      <button class="btn sm" type="button" data-do="more" id="picker-more" hidden>Show more</button></span></div>`;
}

function pickerRows() {
  const list = document.getElementById('picker-list');
  if (!list) return;
  const { stations, total, loading } = ui.pick;
  list.innerHTML = stations.map((station) => `<li class="picker-item">
      ${playButton(`/preview/station/${station.id}`, station.name)}${art(station)}
      <div class="grow"><div class="slot-name clip">${esc(station.name)}</div><div class="slot-sub clip">${esc(stationSub(station))}</div></div>
      <button class="btn sm primary" type="button" data-do="choose" data-station="${station.id}">Choose</button>
    </li>`).join('') || `<li class="picker-item muted">${loading ? 'Searching…' : 'No stations match.'}</li>`;
  document.getElementById('picker-count').textContent = total ? `${total.toLocaleString()} station${total === 1 ? '' : 's'}` : '';
  document.getElementById('picker-more').hidden = stations.length >= total;
}

let searchTimer;
async function runSearch(append = false) {
  const pick = ui.pick;
  if (!pick) return;
  pick.loading = true;
  const params = new URLSearchParams({ q: pick.q, country: pick.country, genre: pick.genre, offset: append ? pick.stations.length : 0, limit: 40 });
  try {
    const found = await api('GET', `/stations?${params}`);
    if (ui.pick !== pick) return;
    pick.stations = append ? pick.stations.concat(found.stations) : found.stations;
    pick.total = found.total;
  } catch (error) {
    toast(error.message, true);
  }
  pick.loading = false;
  pickerRows();
}

async function openPicker(id, slot) {
  const speaker = S.speakers.find((entry) => entry.id === id);
  if (!speaker) return;
  ui.facets ||= await api('GET', '/stations/facets').catch(() => ({ countries: [], genres: [] }));
  ui.pick = { speaker, slot: Number(slot), q: '', country: '', genre: '', stations: [], total: 0, loading: true };
  pickerShell();
  pickerRows();
  picker.showModal();
  runSearch();
}

async function setSlot(value) {
  const { speaker, slot } = ui.pick;
  picker.close();
  try {
    const result = await api('PUT', `/speakers/${speaker.id}/presets/${slot}`, value);
    await refresh();
    toast(result.message || `Button ${slot} updated`);
  } catch (error) {
    toast(error.message, true);
  }
  render();
}

picker.addEventListener('close', () => { ui.pick = null; stopPreview(); });
picker.addEventListener('input', (event) => {
  const field = event.target.dataset.pick;
  if (!field || !ui.pick) return;
  ui.pick[field] = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, field === 'q' ? 200 : 0);
});

/* ---------- listening in the browser ---------- */

function stopPreview() {
  preview.pause();
  preview.removeAttribute('src');
  preview.load();
  ui.playing = null;
}

function togglePreview(src) {
  if (ui.playing === src) stopPreview();
  else {
    ui.playing = src;
    preview.src = src;
    preview.play().catch(() => { toast('That station did not start.', true); stopPreview(); repaint(); });
  }
  repaint();
}

preview.addEventListener('error', () => {
  if (!ui.playing) return;
  toast('That station is not answering right now.', true);
  ui.playing = null;
  repaint();
});

/* ---------- routing and rendering ---------- */

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'setup') return { view: 'setup', step: Math.min(Math.max(Number(parts[1]) || 1, 1), STEPS.length) };
  if (parts[0] === 'health') return { view: 'health' };
  return { view: 'speakers' };
}

function render() {
  if (!S) return;
  let where = route();
  if (!S.setupComplete && where.view !== 'setup') {
    location.replace('#/setup/1');
    return;
  }
  const nav = document.getElementById('nav');
  nav.hidden = !S.setupComplete;
  for (const link of nav.querySelectorAll('a')) {
    if (link.dataset.nav === where.view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  // Redrawing must not wipe what someone is in the middle of typing, as
  // happens when the speaker search finishes while an address is entered.
  const typed = [...app.querySelectorAll('input[type="text"], input[type="url"]')]
    .map((input) => ({ key: input.name || input.id, value: input.value, focused: input === document.activeElement }));
  if (where.view === 'setup') {
    app.innerHTML = [stepWelcome, stepAddress, stepSpeakers, stepMode, stepStations, stepFinish][where.step - 1]();
  } else if (where.view === 'health') {
    app.innerHTML = pageHealth();
  } else {
    app.innerHTML = pageSpeakers();
  }
  for (const { key, value, focused } of typed) {
    const input = key && app.querySelector(`input[name="${key}"], input[id="${key}"]`);
    if (!input || input.type === 'radio') continue;
    if (value) input.value = value;
    if (focused) input.focus();
  }
}

// Redraws whatever is showing the play buttons.
function repaint() {
  if (ui.pick) pickerRows();
  render();
}

let shown = '';
async function arrive() {
  const where = route();
  const key = `${where.view}/${where.step || ''}`;
  render();
  if (key !== shown) {
    shown = key;
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
    if (where.view === 'setup' && where.step === 3 && !ui.found) discover();
    if (where.view === 'health') checkHealth();
  }
}

async function discover() {
  ui.searching = true;
  render();
  try {
    ui.found = (await api('POST', '/discover')).speakers;
  } catch (error) {
    ui.found = [];
    toast(error.message, true);
  }
  ui.searching = false;
  render();
}

async function checkHealth() {
  await during('health', async () => { ui.health = await api('GET', '/health'); });
}

async function addSpeaker(ip) {
  await during('add', async () => {
    const added = await api('POST', '/speakers', { ip, country: new Intl.Locale(navigator.language || 'en').maximize().region || '' });
    const box = app.querySelector('input[name="ip"]');
    if (box) box.value = '';
    await refresh();
    toast(`Added ${added.name}`);
  });
}

async function apply(id) {
  await during(id, async () => {
    ui.results[id] = await api('POST', `/speakers/${id}/apply`);
    await refresh();
  });
}

const actions = {
  next: ({ step }) => { location.hash = `#/setup/${Number(step) + 1}`; },
  discover,
  add: ({ ip }) => addSpeaker(ip),
  health: checkHealth,
  preview: ({ src }) => togglePreview(src),
  pick: ({ id, slot }) => openPicker(id, slot),
  'close-picker': () => picker.close(),
  more: () => runSearch(true),
  choose: ({ station }) => setSlot({ stationId: station }),
  'clear-slot': () => setSlot({ clear: true }),
  apply: ({ id }) => apply(id),
  'apply-all': async () => { for (const speaker of S.speakers) await apply(speaker.id); },

  async 'save-address'() {
    if (S.publicUrlPinned) { location.hash = '#/setup/3'; return; }
    const chosen = document.querySelector('input[name="address"]:checked')?.value || document.getElementById('address-own')?.value.trim();
    if (!chosen) { toast('Choose or enter an address first.', true); return; }
    const saved = await during('next', () => api('POST', '/settings', { publicUrl: chosen }));
    if (!saved) return;
    await refresh();
    if (saved.reachable) {
      ui.addressNote = null;
      location.hash = '#/setup/3';
    } else if (ui.addressNote?.url === chosen) {
      // Asked twice for the same address: take the user's word for it.
      location.hash = '#/setup/3';
    } else {
      ui.addressNote = { ok: false, url: chosen, text: `This server could not reach itself at ${chosen} (${saved.detail}). Check the address, or press Continue again to keep it anyway.` };
      render();
    }
  },

  async remove({ id }) {
    const speaker = S.speakers.find((entry) => entry.id === id);
    const warning = speaker?.migrated ? ' It is still pointed at this server: go back to listening first if you want it returned to how Bose left it.' : '';
    if (!confirm(`Remove ${speaker?.name || 'this speaker'}?${warning}`)) return;
    await during(id, () => api('DELETE', `/speakers/${id}`));
    delete ui.results[id];
    await refresh();
    render();
  },

  async copy({ id }) {
    await during('copy', () => api('POST', `/speakers/${id}/copy`));
    await refresh();
    render();
    toast('Every speaker now has these six.');
  },

  async play({ id, slot }) {
    const done = await during(`play-${id}`, () => api('POST', `/speakers/${id}/play/${slot}`));
    if (done) toast(done.message || `Playing button ${slot}`);
    await refresh();
    render();
  },

  async switch({ id, mode }) {
    const speaker = S.speakers.find((entry) => entry.id === id);
    const question = mode === 'native'
      ? `Point ${speaker.name} at this server in place of Bose? The speaker will restart.`
      : `Return ${speaker.name} to Bose's addresses and go back to listening? The speaker will restart.`;
    if (!confirm(question)) return;
    await during(id, async () => {
      await api('PUT', `/speakers/${id}`, { mode });
      ui.results[id] = await api('POST', `/speakers/${id}/apply`);
      await refresh();
    });
  },

  async finish() {
    await during('next', () => api('POST', '/setup/complete'));
    await refresh();
    ui.results = {};
    location.hash = '#/';
  },

  async sync() {
    await during('sync', () => api('POST', '/stations/sync'));
    await refresh();
    checkHealth();
  },
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-do]');
  if (!target || target.disabled) return;
  actions[target.dataset.do]?.(target.dataset);
});

document.addEventListener('change', async (event) => {
  if (event.target.dataset.change !== 'mode') return;
  try {
    await api('PUT', `/speakers/${event.target.dataset.id}`, { mode: event.target.value });
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
});

document.addEventListener('focusin', (event) => {
  // Typing an address selects the "different address" choice.
  if (event.target.id === 'address-own') event.target.closest('label').querySelector('input[type="radio"]').checked = true;
});

document.addEventListener('submit', (event) => {
  const form = event.target.dataset.form;
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  if (form === 'add-ip') addSpeaker(data.ip.trim());
  if (form === 'own') setSlot({ custom: { name: data.name.trim(), url: data.url.trim() } });
});

// A logo that fails to load steps aside for the initials underneath.
document.addEventListener('error', (event) => {
  if (event.target.matches?.('.art img')) event.target.hidden = true;
}, true);

window.addEventListener('hashchange', arrive);

// The speakers page and the last wizard step follow the speakers live, so a
// button press shows up without reloading. Pages with text fields are left
// alone.
setInterval(async () => {
  const where = route();
  const live = where.view === 'speakers' || (where.view === 'setup' && where.step === 6);
  if (!live || document.hidden || ui.pick || Object.keys(ui.busy).length) return;
  try {
    await refresh();
    render();
  } catch { /* the server is restarting; try again next time */ }
}, 4000);

try {
  await refresh();
  arrive();
} catch (error) {
  app.innerHTML = `<p class="note bad">Could not reach the server: ${esc(error.message)}</p>`;
}
