// Bitmap subtitles (.sub with its .idx, .sup) are image streams, and a frame-based .sub needs a frame rate
// nothing knows before playback, so neither can reach a <track> and neither is offered.
export function subtitleFiles<T extends { name: string; path: string }>(files: T[]): T[] {
  return files.filter(file => /\.(srt|ass|ssa|vtt)$/i.test(file.name))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Valid UTF-8 always decodes, so a fatal throw means a legacy codepage; Western European covers nearly
// every torrent subtitle that is not already UTF-8, and guessing further would need a charset picker.
export function decodeSubtitle(bytes: AllowSharedBufferSource) {
  const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  // UTF-16 is not valid UTF-8, so without this every character would arrive separated by a null byte.
  if (view[0] === 0xFF && view[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
  if (view[0] === 0xFE && view[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

// A leading space and a fourth fraction digit both come out of retiming and OCR tools. A line opening with a
// timestamp and an arrow is never dialogue, so accepting either costs nothing and saves the cue below it.
const TIMING = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d+) *--> *(\d+):(\d{1,2}):(\d{1,2})[.,](\d+)/;
// An SRT converted from an ASS keeps override tags such as {\an8} or {\i1}, and WebVTT has no syntax for them,
// so a browser prints them. Only a brace block that opens with a backslash goes, which leaves a brace someone
// actually said alone; stopping the class at the next brace keeps the scan linear on a hostile line.
const SRT_OVERRIDE = /\{\\[^{}]*\}/g;
// Layer, Start, End, then the six fields before Text, which keeps every comma of its own. A \s* in front of
// [^,]* would let the two split a run of spaces every possible way, which a crafted line stretches into
// minutes; Text matches every character rather than '.', which alone never crosses a U+2028 or U+2029.
const DIALOGUE = /^Dialogue:[^,]*,([^,]+),([^,]+),(?:[^,]*,){6}([\s\S]*)$/;

const clock = (h: string, m: string, s: string, ms: string) =>
  `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms.slice(0, 3).padEnd(3, '0')}`;

// WebVTT reads an arrow in cue text as the start of the next cue, which would swallow every cue after it,
// and any '<' as the start of a tag, which swallows the rest of the cue up to the next '>' — so 'I <3 you'
// renders as 'I '. Keep the tags a browser really renders and escape every other '<'.
const CUE_TAG = /<\/?(?:c|i|b|u|v|ruby|rt|lang)(?:[.\s][^<>]*)?>|<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>|-->|</gi;
const escapeCue = (line: string) => line
  // <font color=…> is common in SRT and browsers drop it today, so drop it here too rather than print it.
  .replace(/<\/?font\b[^>]*>/gi, '')
  .replace(CUE_TAG, match => match === '<' ? '&lt;' : match === '-->' ? '--&gt;' : match);

// ASS counts hundredths where WebVTT counts thousandths.
function assClock(value: string) {
  const parts = /^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,2})$/.exec(value.trim());
  return parts ? clock(parts[1], parts[2], parts[3], `${parts[4].padEnd(2, '0')}0`) : '';
}

// A '{' with no '}' after it opens no override block, so only the text up to the last '}' is scanned. Without
// that bound the pattern rescans to the end of the line from every one of those '{', which a crafted line
// stretches into minutes of blocked main thread.
const stripOverrides = (text: string) => {
  const end = text.lastIndexOf('}') + 1;
  return text.slice(0, end).replace(/\{[^}]*\}/g, '') + text.slice(end);
};

// WebVTT is the only format a <track> can load. Styling, positioning and karaoke are dropped to plain text,
// which is what the MKV player already does with the same subtitle muxed into the movie.
export function toWebVTT(text: string, filename: string) {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // A browser rejects a whole .vtt whose signature is missing, so only a real one skips the rewrite below;
  // an .srt that was renamed .vtt falls through and is repaired instead of attaching an empty track.
  if (/\.vtt$/i.test(filename) && /^WEBVTT([ \t\n]|$)/.test(body)) return body;
  if (/\.(ass|ssa)$/i.test(filename)) {
    const cues = [];
    for (const line of body.split('\n')) {
      const dialogue = DIALOGUE.exec(line);
      // A vector drawing keeps its coordinates in the text field and would render as visible gibberish.
      if (!dialogue || /\\p[1-9]/.test(dialogue[3])) continue;
      const start = assClock(dialogue[1]), end = assClock(dialogue[2]);
      // A \N\N asks for a vertical gap, but WebVTT ends the cue at the empty line and everything the dialogue
      // says after it is never shown, so the gap goes and the words stay.
      const cue = escapeCue(stripOverrides(dialogue[3]).replaceAll('\\h', ' ').replace(/\\[Nn]/g, '\n')).split('\n').filter(part => part.trim()).join('\n').trim();
      if (start && end && cue) cues.push(`${start} --> ${end}\n${cue}`);
    }
    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
  }
  // Rewriting only the timing lines leaves cue numbers, blank lines and <i>/<b> tags alone: WebVTT reads a
  // numeric line as a cue identifier and renders those tags itself, so every one of them is already legal.
  const lines = body.split('\n').flatMap(line => {
    const timing = TIMING.exec(line);
    if (timing) return `${clock(timing[1], timing[2], timing[3], timing[4])} --> ${clock(timing[5], timing[6], timing[7], timing[8])}`;
    // Only a truly empty line ends a cue, so a separator holding a space or a tab leaves the cue open and it
    // swallows the next cue's number; a line the override strip emptied is the mirror image and just goes.
    if (!line.trim()) return '';
    const text = escapeCue(line.replace(SRT_OVERRIDE, ''));
    return text.trim() ? text : [];
  });
  return `WEBVTT\n\n${lines.join('\n')}\n`;
}
