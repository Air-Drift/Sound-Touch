import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstEntry } from '../src/proxy.mjs';
import { attr, element, elements, esc, text } from '../src/xml.mjs';

test('reads elements, attributes and escaped text', () => {
  const xml = '<presets><preset id="1"><ContentItem source="UPNP" location="http://a/b?x=1&amp;y=2"><itemName>Rock &amp; Roll</itemName></ContentItem></preset><preset id="2"/></presets>';
  assert.deepEqual(elements(xml, 'preset').map((p) => p.attrs.id), ['1', '2']);
  assert.equal(attr(xml, 'ContentItem', 'location'), 'http://a/b?x=1&y=2');
  assert.equal(text(xml, 'itemName'), 'Rock & Roll');
  assert.equal(element(xml, 'missing'), null);
});

test('does not confuse an element with one whose name it starts', () => {
  assert.equal(text('<nowPlaying><trackID>9</trackID><track>Song</track></nowPlaying>', 'track'), 'Song');
});

test('escapes what goes into XML', () => {
  assert.equal(esc(`a<b>&"c"'`), 'a&lt;b&gt;&amp;&quot;c&quot;&apos;');
});

test('finds the stream inside .pls and .m3u playlists', () => {
  assert.equal(firstEntry('[playlist]\nNumberOfEntries=1\nFile1=http://a.example/live\nTitle1=A', 'http://x/'), 'http://a.example/live');
  assert.equal(firstEntry('#EXTM3U\n#EXTINF:-1,A\nhttps://b.example/live.mp3\n', 'http://x/'), 'https://b.example/live.mp3');
  assert.equal(firstEntry('#EXTM3U\nlive/stream.aac\n', 'http://c.example/radio/list.m3u'), 'http://c.example/radio/live/stream.aac');
  assert.equal(firstEntry('<html>nothing here</html>', 'http://x/'), null);
});
