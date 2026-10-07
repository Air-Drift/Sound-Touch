// The speaker's documents are small and flat, so a few regular expressions
// read them; no XML parser is bundled.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

export const unesc = (value) =>
  String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ref) => {
    if (ref[0] !== '#') return NAMED[ref.toLowerCase()];
    const code = ref[1].toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const open = (name) => `<${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${name}>)`;

function attrs(text) {
  const out = {};
  for (const m of (text || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = unesc(m[2] ?? m[3]);
  }
  return out;
}

// Every <name> element: its attributes, raw inner XML and trimmed text.
export function elements(xml, name) {
  return [...String(xml ?? '').matchAll(new RegExp(open(name), 'g'))].map((m) => ({
    attrs: attrs(m[1]),
    inner: m[2] ?? '',
    text: unesc((m[2] ?? '').trim()),
  }));
}

export const element = (xml, name) => elements(xml, name)[0] || null;
export const text = (xml, name) => element(xml, name)?.text ?? '';
export const attr = (xml, name, attribute) => element(xml, name)?.attrs[attribute] ?? '';
