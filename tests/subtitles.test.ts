import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSubtitle, subtitleFiles, toWebVTT } from '../lib/subtitles.ts';

test('SRT cues are re-emitted in the WebVTT timestamp grammar', () => {
  const vtt = toWebVTT('1\n00:00:01,000 --> 00:00:02,500\nHello\n', 'a.srt');
  assert.ok(vtt.startsWith('WEBVTT\n\n'), 'a file without the header parses as zero cues');
  assert.match(vtt, /^00:00:01\.000 --> 00:00:02\.500$/m);
  assert.match(vtt, /^1$/m, 'a leading number is a legal WebVTT cue identifier, so it is kept');
  assert.match(toWebVTT('0:00:01,5 --> 0:1:02,00\nx', 'a.srt'), /^00:00:01\.500 --> 00:01:02\.000$/m);
  assert.match(toWebVTT('00:00:01,000-->00:00:02,000\nx', 'a.srt'), /^00:00:01\.000 --> 00:00:02\.000$/m);
  assert.match(toWebVTT('00:00:01.000 --> 00:00:02.000\nx', 'a.srt'), /^00:00:01\.000 --> 00:00:02\.000$/m);
  assert.ok(!toWebVTT('00:00:01,000 --> 00:00:02,000  X1:040 X2:600 Y1:460 Y2:480\nHi', 'a.srt').includes('X1:040'),
    'SRT cue coordinates are not valid WebVTT cue settings');
});

test('line endings, a byte-order mark and a stray arrow never corrupt the cues', () => {
  const crlf = toWebVTT('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n', 'a.srt');
  assert.ok(!crlf.includes('\r') && !crlf.includes('﻿'));
  assert.match(crlf, /^Hello$/m);
  assert.match(toWebVTT('1\r00:00:01,000 --> 00:00:02,000\rHello', 'a.srt'), /^00:00:01\.000 --> 00:00:02\.000$/m);
  const arrow = toWebVTT('1\n00:00:01,000 --> 00:00:02,000\nprofit --> loss\n', 'a.srt');
  assert.match(arrow, /^profit --&gt; loss$/m);
  assert.equal((arrow.match(/ --> /g) ?? []).length, 1, 'an arrow left in cue text starts a phantom cue');
});

test('cue text is otherwise carried through verbatim', () => {
  const commas = toWebVTT('1\n00:00:01,000 --> 00:00:02,000\n1, 2, 3, 4, 5, 6, 7, 8, 9\n', 'a.srt');
  assert.match(commas, /^1, 2, 3, 4, 5, 6, 7, 8, 9$/m, 'a comma-heavy line must not be read as an ASS field list');
  assert.match(toWebVTT('1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i>, world\n', 'a.srt'), /^<i>Hello<\/i>, world$/m);
});

test('an ASS dialogue becomes a plain-text cue', () => {
  const out = toWebVTT([
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:01:02.34,0:01:04.00,Default,,0,0,0,,{\\an8}Hello,\\Nworld, friend',
    'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,never shown',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10',
    'Dialogue: Marked=0,0:00:07.00,0:00:08.00,Default,,0,0,0,,Legacy SSA',
  ].join('\n'), 'a.ass');
  assert.match(out, /^00:01:02\.340 --> 00:01:04\.000$/m, 'ASS counts hundredths, WebVTT thousandths');
  assert.match(out, /^Hello,$/m);
  assert.match(out, /^world, friend$/m, 'the text field keeps its own commas');
  assert.ok(!out.includes('{'), 'override tags are stripped');
  assert.ok(!out.includes('never shown'), 'Comment lines are not dialogue');
  assert.ok(!out.includes('m 0 0 l'), 'a vector drawing would render as visible gibberish');
  assert.match(out, /^00:00:07\.000 --> 00:00:08\.000$/m);
  assert.match(out, /^Legacy SSA$/m);
});

test('a WebVTT file is already the target format', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n';
  assert.equal(toWebVTT(vtt, 'a.vtt'), vtt);
  assert.equal(toWebVTT(vtt.replaceAll('\n', '\r\n'), 'a.vtt'), vtt);
  // Without its signature a browser rejects the whole file, so a renamed SRT is repaired, not passed through.
  const renamed = toWebVTT('1\n00:00:01,000 --> 00:00:02,000\nHello\n', 'a.vtt');
  assert.ok(renamed.startsWith('WEBVTT\n\n'));
  assert.match(renamed, /^00:00:01\.000 --> 00:00:02\.000$/m);
});

test('text subtitles are offered and bitmap subtitles are not', () => {
  const files = [
    { name: 'Movie.mkv', path: 'Movie.mkv' },
    { name: 'Spanish.srt', path: 'Subs/Spanish.srt' },
    { name: 'English.srt', path: 'Subs/English.srt' },
    { name: 'Signs.ASS', path: 'Signs.ASS' },
    { name: 'old.sub', path: 'old.sub' },
    { name: 'old.idx', path: 'old.idx' },
    { name: 'disc.sup', path: 'disc.sup' },
    { name: 'notes.txt', path: 'notes.txt' },
  ];
  assert.deepEqual(subtitleFiles(files).map(file => file.path), ['Signs.ASS', 'Subs/English.srt', 'Subs/Spanish.srt']);
  assert.equal(files[0].name, 'Movie.mkv', 'selection must not reorder the torrent metadata');
});

test('a subtitle saved in a legacy codepage still reads as text', () => {
  assert.equal(decodeSubtitle(new Uint8Array([0x63, 0x61, 0x66, 0xC3, 0xA9])), 'café');
  // Only bytes from 0xA0 up agree between Node's windows-1252 table and the browser's.
  assert.equal(decodeSubtitle(new Uint8Array([0x63, 0x61, 0x66, 0xE9])), 'café');
  // A subtitle saved as "Unicode" from a Windows editor is UTF-16, which is never valid UTF-8.
  assert.equal(decodeSubtitle(new Uint8Array([0xFF, 0xFE, 0x63, 0, 0x61, 0, 0x66, 0, 0xE9, 0])), 'café');
  assert.equal(decodeSubtitle(new Uint8Array([0xFE, 0xFF, 0, 0x63, 0, 0x61, 0, 0x66, 0, 0xE9])), 'café');
});
