import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, ADTS, MkvOutputFormat, Output } from 'mediabunny';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const playsvideo = import.meta.resolve('playsvideo');
const { default: createFFmpegCore } = await import(new URL('./vendor/ffmpeg-core-audio/ffmpeg-core.js', playsvideo).href);
const { demuxBlob, demuxFile, demuxUrl, collectPacketsInRange, getKeyframeIndex } = await import(new URL('./pipeline/demux.js', playsvideo).href);
const { buildMkvKeyframeIndexFromUrl } = await import(new URL('./pipeline/mkv-keyframe-index.js', playsvideo).href);
const { buildSegmentPlan } = await import(new URL('./pipeline/segment-plan.js', playsvideo).href);
const { processSegmentWithAbort } = await import(new URL('./pipeline/segment-processor.js', playsvideo).href);

test('MKV range streaming indexes metadata, remuxes video and audio, and seeks to a later segment', { timeout: 60000 }, async () => {
  // Repeat a synthetic two-second clip to make a movie-sized index without
  // keeping a large fixture in the repository. No codecs need to be re-encoded.
  const clip = await demuxFile(fileURLToPath(new URL('./fixtures/h264-aac.mp4', import.meta.url)));
  const videoPackets = await collectPacketsInRange(clip.videoSink, 0, 2, { startFromKeyframe: true });
  const audioPackets = await collectPacketsInRange(clip.audioSink, 0, 2);
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat(), target });
  const video = new EncodedVideoPacketSource(clip.videoCodec);
  const audio = new EncodedAudioPacketSource(clip.audioCodec);
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  const packets = [
    ...videoPackets.map(packet => ({ packet, source: video, config: clip.videoDecoderConfig })),
    ...audioPackets.map(packet => ({ packet, source: audio, config: clip.audioDecoderConfig })),
  ].sort((a, b) => a.packet.timestamp - b.packet.timestamp);
  for (let repeat = 0; repeat < 30; repeat++) {
    for (const { packet, source, config } of packets) {
      await source.add(packet.clone({ timestamp: packet.timestamp + repeat * 2 }), { decoderConfig: config });
    }
  }
  video.close(); audio.close();
  await output.finalize();
  clip.dispose();
  const movie = Buffer.from(target.buffer);
  assert.ok(movie.length > 2_000_000);

  let rangeBytes = 0;
  const server = createServer((request, response) => {
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'video/x-matroska');
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Length': movie.length }); response.end(); return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (!range) { response.writeHead(400); response.end(); return; }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : movie.length - 1, movie.length - 1);
    rangeBytes += end - start + 1;
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${movie.length}`, 'Content-Length': end - start + 1 });
    response.end(movie.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/movie.mkv`;
  let demux;
  try {
    const index = await buildMkvKeyframeIndexFromUrl(url);
    assert.ok(index && index.keyframes.length > 1, 'MKV cue index must be usable');
    assert.ok(rangeBytes < movie.length * .05, 'indexing must not download the whole movie');
    const plan = buildSegmentPlan({ keyframeTimestampsSec: index.keyframes.map(k => k.timestamp), durationSec: index.duration, targetSegmentDurationSec: 4 });
    demux = await demuxUrl(url);
    assert.equal(demux.videoCodec, 'avc');
    assert.equal(demux.audioCodec, 'aac');
    const config = { videoSink: demux.videoSink, audioSink: demux.audioSink, videoCodec: demux.videoCodec,
      audioCodec: demux.audioCodec, videoDecoderConfig: demux.videoDecoderConfig, audioDecoderConfig: demux.audioDecoderConfig,
      plan, doTranscode: false, transcodeAudio: () => { throw new Error('AAC should not need conversion'); } };
    for (const segmentIndex of [0, Math.floor(plan.length / 2)]) {
      const segment = await processSegmentWithAbort(config, segmentIndex);
      assert.ok(segment.mediaData.length > 0);
      const playable = new Input({ source: new BufferSource(Buffer.concat([segment.initSegment, segment.mediaData])), formats: [MP4] });
      const videoTrack = await playable.getPrimaryVideoTrack();
      const audioTrack = await playable.getPrimaryAudioTrack();
      assert.equal(videoTrack.codec, 'avc');
      assert.equal(audioTrack.codec, 'aac');
      assert.ok(Math.abs(await videoTrack.getFirstTimestamp() - plan[segmentIndex].startSec) < .05);
      playable.dispose();
    }
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(processSegmentWithAbort(config, 0, aborted.signal), { name: 'AbortError' });
  } finally {
    demux?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a movie whose video starts seconds in still fills its first segment', { timeout: 60000 }, async () => {
  // The webpack loader applies scripts/playsvideo-patches.json to the module the browser runs, so apply it
  // the same way here: this is the only place a playsvideo upgrade that moved the patched line is caught
  // outside a production build.
  const patches = JSON.parse(await readFile(new URL('../scripts/playsvideo-patches.json', import.meta.url), 'utf8'));
  let code = await readFile(new URL('./pipeline/segment-plan.js', playsvideo), 'utf8');
  for (const { find, replace, count } of patches['pipeline/segment-plan.js']) {
    assert.equal(code.split(find).length - 1, count, 'the patched segment-plan source moved');
    code = code.replaceAll(find, replace);
  }
  const { buildSegmentPlan: buildPatchedPlan } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  // An ordinary movie keyframes at zero and is planned exactly as before.
  assert.equal(buildPatchedPlan({ keyframeTimestampsSec: [0, 4, 8], durationSec: 12, targetSegmentDurationSec: 4 })[0].startSec, 0);

  // A copyts-style remux or a cut recording keeps container time, so its first keyframe can be seconds in.
  const clip = await demuxFile(fileURLToPath(new URL('./fixtures/h264-aac.mp4', import.meta.url)));
  const videoPackets = await collectPacketsInRange(clip.videoSink, 0, 2, { startFromKeyframe: true });
  const audioPackets = await collectPacketsInRange(clip.audioSink, 0, 2);
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat(), target });
  const video = new EncodedVideoPacketSource(clip.videoCodec);
  const audio = new EncodedAudioPacketSource(clip.audioCodec);
  output.addVideoTrack(video);
  output.addAudioTrack(audio);
  await output.start();
  const packets = [
    ...videoPackets.map(packet => ({ packet, source: video, config: clip.videoDecoderConfig })),
    ...audioPackets.map(packet => ({ packet, source: audio, config: clip.audioDecoderConfig })),
  ].sort((a, b) => a.packet.timestamp - b.packet.timestamp);
  for (let repeat = 0; repeat < 4; repeat++) {
    for (const { packet, source, config } of packets) {
      await source.add(packet.clone({ timestamp: packet.timestamp + 5 + repeat * 2 }), { decoderConfig: config });
    }
  }
  video.close(); audio.close();
  await output.finalize();
  clip.dispose();

  const demux = await demuxBlob(new Blob([target.buffer]));
  try {
    const index = await getKeyframeIndex(demux.videoSink, demux.duration);
    assert.ok(Math.abs(index.keyframes[0].timestamp - 5) < .05, 'the fixture must keep its container time');
    const options = { keyframeTimestampsSec: index.keyframes.map(k => k.timestamp), durationSec: index.duration, targetSegmentDurationSec: 4 };
    const config = plan => ({ videoSink: demux.videoSink, audioSink: demux.audioSink, videoCodec: demux.videoCodec,
      audioCodec: demux.audioCodec, videoDecoderConfig: demux.videoDecoderConfig, audioDecoderConfig: demux.audioDecoderConfig,
      plan, doTranscode: false, transcodeAudio: () => { throw new Error('AAC should not need conversion'); } });
    // Planned from zero, segment 0 spans [0, 5) and carries nothing but an empty fragment, which hls.js
    // reports to the whole room as a fatal fragParsingError.
    const bare = await processSegmentWithAbort(config(buildSegmentPlan(options)), 0);
    const plan = buildPatchedPlan(options);
    assert.ok(Math.abs(plan[0].startSec - 5) < .05);
    const segment = await processSegmentWithAbort(config(plan), 0);
    assert.ok(segment.mediaData.length > bare.mediaData.length * 10, 'the first segment must carry media');
    const playable = new Input({ source: new BufferSource(Buffer.concat([segment.initSegment, segment.mediaData])), formats: [MP4] });
    const videoTrack = await playable.getPrimaryVideoTrack();
    assert.ok(Math.abs(await videoTrack.getFirstTimestamp() - 5) < .05);
    playable.dispose();
  } finally { demux.dispose(); }
});

test('an MKV whose first audio track is DTS plays on the track behind it', { timeout: 60000 }, async () => {
  // mediabunny does not map A_DTS, A_TRUEHD or A_MPEG/L2, so the primary audio track of such a release has
  // no codec: playsvideo muxes its packets with no decoder config and the whole room gets a raw TypeError.
  // A_DTS is the same length as A_AAC, so rewriting the first CodecID in place needs no size fix-ups.
  const clip = await demuxFile(fileURLToPath(new URL('./fixtures/h264-aac.mp4', import.meta.url)));
  const videoPackets = await collectPacketsInRange(clip.videoSink, 0, 2, { startFromKeyframe: true });
  const audioPackets = await collectPacketsInRange(clip.audioSink, 0, 2);
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat(), target });
  const video = new EncodedVideoPacketSource(clip.videoCodec);
  const first = new EncodedAudioPacketSource(clip.audioCodec);
  const second = new EncodedAudioPacketSource(clip.audioCodec);
  output.addVideoTrack(video);
  output.addAudioTrack(first);
  output.addAudioTrack(second);
  await output.start();
  for (const packet of videoPackets) await video.add(packet, { decoderConfig: clip.videoDecoderConfig });
  for (const packet of audioPackets) {
    await first.add(packet, { decoderConfig: clip.audioDecoderConfig });
    await second.add(packet.clone({}), { decoderConfig: clip.audioDecoderConfig });
  }
  video.close(); first.close(); second.close();
  await output.finalize();
  clip.dispose();
  const movie = Buffer.from(target.buffer);
  const codecId = movie.indexOf('A_AAC', 0, 'latin1');
  assert.ok(codecId > 0, 'the fixture must carry an A_AAC CodecID to rewrite');
  movie.write('A_DTS', codecId, 'latin1');

  const unpatched = await demuxBlob(new Blob([movie]));
  try { assert.equal(unpatched.audioCodec, null, 'the unpatched demuxer must still pick the unidentified track'); }
  finally { unpatched.dispose(); }

  // The webpack loader applies scripts/playsvideo-patches.json to the module the browser runs; run the
  // patched source here so a playsvideo upgrade that moved the line is caught outside a production build.
  const patches = JSON.parse(await readFile(new URL('../scripts/playsvideo-patches.json', import.meta.url), 'utf8'));
  let code = await readFile(new URL('./pipeline/demux.js', playsvideo), 'utf8');
  for (const { find, replace, count } of patches['pipeline/demux.js']) {
    assert.equal(code.split(find).length - 1, count, 'the patched demux source moved');
    code = code.replaceAll(find, replace);
  }
  // A data: module resolves neither bare nor relative specifiers, so point both at the files it would reach.
  code = code.replace("from 'mediabunny'", `from '${import.meta.resolve('mediabunny')}'`)
    .replace("from './subtitle.js'", `from '${new URL('./pipeline/subtitle.js', playsvideo).href}'`);
  const { demuxBlob: demuxPatched } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const patched = await demuxPatched(new Blob([movie]));
  try {
    assert.equal(patched.audioCodec, 'aac');
    assert.ok(patched.audioDecoderConfig, 'the chosen track must carry a decoder config to mux with');
  } finally { patched.dispose(); }

  // With nothing else to fall back to, the worker refuses by name rather than throwing out of the muxer.
  const workerCode = await readFile(new URL('./worker.js', playsvideo), 'utf8');
  const refusal = patches['worker.js'].find(patch => patch.replace.includes('unsupported-audio'));
  assert.equal(workerCode.split(refusal.find).length - 1, refusal.count, 'the patched worker source moved');
});

test('an MKV whose DTS main track is followed by a commentary plays the film’s other soundtrack', { timeout: 60000 }, async () => {
  // Releases pair a DTS main track with a director's commentary and a dub. The fallback took the first track it
  // could play, which was the commentary: the room watched the film with the director talking over it.
  const clip = await demuxFile(fileURLToPath(new URL('./fixtures/h264-aac.mp4', import.meta.url)));
  const videoPackets = await collectPacketsInRange(clip.videoSink, 0, 2, { startFromKeyframe: true });
  const audioPackets = await collectPacketsInRange(clip.audioSink, 0, 2);
  const target = new BufferTarget();
  const output = new Output({ format: new MkvOutputFormat(), target });
  const video = new EncodedVideoPacketSource(clip.videoCodec);
  const tracks = [
    { languageCode: 'eng', name: 'English DTS-HD MA', disposition: { default: true } },
    { languageCode: 'eng', name: 'Commentary with the director', disposition: { default: false, commentary: true } },
    { languageCode: 'fre', name: 'Français', disposition: { default: false } },
  ].map(metadata => ({ source: new EncodedAudioPacketSource(clip.audioCodec), metadata }));
  output.addVideoTrack(video);
  for (const { source, metadata } of tracks) output.addAudioTrack(source, metadata);
  await output.start();
  for (const packet of videoPackets) await video.add(packet, { decoderConfig: clip.videoDecoderConfig });
  for (const packet of audioPackets) for (const { source } of tracks) await source.add(packet.clone({}), { decoderConfig: clip.audioDecoderConfig });
  video.close(); for (const { source } of tracks) source.close();
  await output.finalize();
  clip.dispose();
  const movie = Buffer.from(target.buffer);
  movie.write('A_DTS', movie.indexOf('A_AAC', 0, 'latin1'), 'latin1');

  const patches = JSON.parse(await readFile(new URL('../scripts/playsvideo-patches.json', import.meta.url), 'utf8'));
  let code = await readFile(new URL('./pipeline/demux.js', playsvideo), 'utf8');
  for (const { find, replace, count } of patches['pipeline/demux.js']) {
    assert.equal(code.split(find).length - 1, count, 'the patched demux source moved');
    code = code.replaceAll(find, replace);
  }
  code = code.replace("from 'mediabunny'", `from '${import.meta.resolve('mediabunny')}'`)
    .replace("from './subtitle.js'", `from '${new URL('./pipeline/subtitle.js', playsvideo).href}'`);
  const { demuxBlob: demuxPatched } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const patched = await demuxPatched(new Blob([movie]));
  try {
    assert.equal(patched.audioCodec, 'aac');
    assert.equal(patched.audioTrack.disposition.commentary, false, 'the commentary was chosen over the dub');
    assert.equal(patched.audioTrack.languageCode, 'fre');
  } finally { patched.dispose(); }
});

test('an MKV whose cues index its subtitles too is planned from the video cues alone', async () => {
  // mkvmerge and FFmpeg write a cue point for every subtitle event as well as for keyframes, and every one of them
  // became a segment boundary: each segment starting between keyframes re-cuts the video from the keyframe before
  // it, the appends overlap, and a seat near its buffer edge froze on the picture. The video is track 2 here, so
  // taking track 1 for video would not pass either.
  const vint = value => {
    for (let length = 1; ; length++) if (value < 2 ** (7 * length) - 1) {
      const bytes = Array.from({ length }, (_, i) => Math.floor(value / 256 ** (length - 1 - i)) % 256);
      bytes[0] |= 0x80 >> (length - 1);
      return bytes;
    }
  };
  const id = value => { const length = Math.ceil(Math.log2(value + 1) / 8); return Array.from({ length }, (_, i) => (value >>> (8 * (length - 1 - i))) & 0xff); };
  const el = (elementId, ...children) => { const body = children.flat(); return [...id(elementId), ...vint(body.length), ...body]; };
  const uint = (elementId, value) => el(elementId, ...Array.from({ length: 4 }, (_, i) => Math.floor(value / 256 ** (3 - i)) % 256));
  const duration = Buffer.alloc(8); duration.writeDoubleBE(30000);
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), el(0x4489, ...duration));
  const cue = (ms, track) => el(0xbb, uint(0xb3, ms), el(0xb7, uint(0xf7, track), uint(0xf1, 0)));
  const seek = (target, position) => el(0x4dbb, el(0x53ab, ...id(target)), uint(0x53ac, position));
  const seekHead = positions => el(0x114d9b74, seek(0x1549a966, positions[0]), seek(0x1654ae6b, positions[1]), seek(0x1c53bb6b, positions[2]));
  const mkv = (tracks, times) => {
    const cues = el(0x1c53bb6b, ...times.map(([ms, track]) => cue(ms, track)));
    const head = seekHead([0, 0, 0]).length;
    const body = [...seekHead([head, head + info.length, head + info.length + tracks.length]), ...info, ...tracks, ...cues];
    return Uint8Array.from([...el(0x1a45dfa3, uint(0x4286, 1)), ...el(0x18538067, ...body)]);
  };
  const times = [[0, 2], [3100, 1], [6200, 1], [9300, 1], [10000, 2], [12400, 1], [15500, 1], [18600, 1], [20000, 2], [21700, 1]];
  const movie = mkv(el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x83, 0x11)), el(0xae, uint(0xd7, 2), uint(0x83, 1))), times);
  const read = async (start, end) => movie.subarray(start, end);

  const source = await readFile(new URL('./pipeline/mkv-keyframe-index.js', playsvideo), 'utf8');
  const { parseMkvCueIndex: unpatched } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.equal((await unpatched(read, movie.length)).cuePoints.length, times.length, 'the unpatched parser must still take every cue point');
  const patches = JSON.parse(await readFile(new URL('../scripts/playsvideo-patches.json', import.meta.url), 'utf8'));
  let code = source;
  for (const { find, replace, count } of patches['pipeline/mkv-keyframe-index.js']) {
    assert.equal(code.split(find).length - 1, count, 'the patched cue parser source moved');
    code = code.replaceAll(find, replace);
  }
  const { parseMkvCueIndex } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const parsed = await parseMkvCueIndex(read, movie.length);
  assert.deepEqual(parsed.cuePoints.map(point => point.timestampMs), [0, 10000, 20000]);
  assert.equal(parsed.durationSec, 30);
  // Of two video tracks mediabunny plays the first enabled one flagged default, so that is the one whose cues plan it.
  const twoVideos = mkv(el(0x1654ae6b, el(0xae, uint(0xd7, 1), uint(0x83, 1), uint(0x88, 0)), el(0xae, uint(0xd7, 2), uint(0x83, 1))),
    [[0, 1], [0, 2], [5000, 1], [10000, 2], [15000, 1], [20000, 2], [25000, 1]]);
  assert.deepEqual((await parseMkvCueIndex(async (start, end) => twoVideos.subarray(start, end), twoVideos.length)).cuePoints.map(point => point.timestampMs), [0, 10000, 20000]);
});

// The segment processor as the browser runs it, with the build's patches, and as playsvideo ships it.
async function segmentProcessors() {
  const source = await readFile(new URL('./pipeline/segment-processor.js', playsvideo), 'utf8');
  const patches = JSON.parse(await readFile(new URL('../scripts/playsvideo-patches.json', import.meta.url), 'utf8'));
  let code = source;
  for (const { find, replace, count } of patches['pipeline/segment-processor.js']) {
    assert.equal(code.split(find).length - 1, count, 'the patched segment-processor source moved');
    code = code.replaceAll(find, replace);
  }
  // A data: module resolves neither bare nor relative specifiers, so point each at the file it would reach.
  const load = async text => (await import(`data:text/javascript,${encodeURIComponent(['demux', 'mux', 'source-signal'].reduce(
    (out, name) => out.replace(`from './${name}.js'`, `from '${new URL(`./pipeline/${name}.js`, playsvideo).href}'`),
    text.replace("from 'mediabunny'", `from '${import.meta.resolve('mediabunny')}'`)))}`)).processSegmentWithAbort;
  return { unpatched: await load(source), patched: await load(code) };
}

const SILENT_STEREO_AAC = [0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80];
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Runs a plan, by default three segments to 2 s cut between audio packets as a 25 fps film's keyframes are, over a
// stand-in soundtrack running from `start` to `end` seconds: AC-3, E-AC-3, MP3 or FLAC converted by a stand-in for
// ffmpeg, each packet led by its codec's frame header (or `header`), or AAC-LC passed through with the
// AudioSpecificConfig `asc` (by default FFmpeg's: the two bytes of AAC-LC, then an
// extension saying there is no SBR). `stamp` moves packets, to make a track irregular, and
// `zeroEvery` gives every so many packets no duration, as FFmpeg's muxer leaves the last one in each cluster, and
// `order` processes the segments in another order, as a seek has hls.js ask for them.
// Returns what each segment's fMP4 declares and plays, the span of audio each conversion run was given, and how
// many packet lookups each segment made (in a real file, a lookup past the soundtrack's end reads on to the end
// of the file).
async function playSegments(process, clip, { rate = 48000, start = 0, end = 2.2, convert = true, codec = convert ? 'ac3' : 'aac',
  cuts = [0, 0.53, 1.12], until = 2, stamp = at => at, size = convert ? 1536 : 1024, zeroEvery = 0, asc, order = cuts.map((_, i) => i),
  header = { eac3: [0x0b, 0x77, 0, 0, [256, 512, 768, 1536].indexOf(size) << 4, 16 << 3], mp3: [0xff, size === 1152 ? 0xfb : 0xf3, 0x90, 0],
    flac: [0xff, 0xf8, { 192: 1, 1152: 3, 4608: 5, 4096: 12 }[size] << 4 | 9, 0x08] }[codec] ?? [] } = {}) {
  const plan = cuts.map((startSec, i) => ({ startSec, durationSec: (cuts[i + 1] ?? until) - startSec }));
  // The track as mediabunny reads one from an MKV: packets stamped to the millisecond, each lasting until the next,
  // led by the frame header, then carrying their stamp, their true length and the exact time their sound starts.
  const count = Math.ceil((end - start) * rate / size);
  const stamps = Array.from({ length: count }, (_, i) => stamp(start + Math.round(i * size / rate * 1000) / 1000));
  const track = stamps.map((at, i) => {
    const lasts = (stamps[i + 1] ?? at + size / rate) - at;
    const data = new Uint8Array(32);
    data.set(header);
    new Float64Array(data.buffer, 8).set([at, lasts, stamp(start + i * size / rate)]);
    return new EncodedPacket(data, 'key', at, zeroEvery && i % zeroEvery === zeroEvery - 1 ? 0 : lasts, i);
  });
  const reads = plan.map(() => ({ lookups: 0, pastEnd: 0 }));
  let current = 0;
  const audioSink = {
    // Read for its metadata only, a packet comes back without its bytes, as mediabunny's placeholders do.
    getFirstPacket: async options => options?.metadataOnly ? new EncodedPacket(new Uint8Array(0), 'key', track[0].timestamp, track[0].duration, 0) : track[0],
    getPacket: async at => { reads[current].lookups++; return track.findLast(packet => packet.timestamp <= at) ?? null; },
    getNextPacket: async packet => {
      reads[current].lookups++;
      const next = track[packet.sequenceNumber + 1] ?? null;
      if (!next) reads[current].pastEnd++;
      return next;
    },
  };
  // Stands in for ffmpeg: after its priming frame, one AAC frame per 1024 source samples, each carrying the source
  // time it holds, so that what a frame plays can be checked against when it is stamped to play. ffmpeg's frames
  // are ADTS, which the muxer strips, so these carry an ADTS header too.
  const adts = payload => Uint8Array.from([0xff, 0xf1, 0x40 | AAC_RATES.indexOf(rate) << 2, 0x80,
    (7 + payload.length) >> 3, ((7 + payload.length) & 7) << 5 | 0x1f, 0xfc, ...payload]);
  const runs = [];
  const transcodeAudio = async ({ packets, sampleRate, audioStartSec }) => {
    const from = packets[0].timestamp, to = packets.at(-1).timestamp + packets.at(-1).duration, frameSec = 1024 / sampleRate;
    const sound = new Float64Array(packets[0].data.slice().buffer, 8)[2];
    runs.push({ start: from, end: to });
    return {
      packets: Array.from({ length: Math.ceil((Math.round(packets.length * size) + 1024) / 1024) }, (_, i) =>
        new EncodedPacket(adts(new Uint8Array(new Float64Array([sound + (i - 1) * frameSec]).buffer)), 'key', audioStartSec + i * frameSec, frameSec, i)),
      decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate },
      metrics: { totalMs: 0, audioDurationSec: 0, realtimeRatio: 0, ffmpegMs: 0, ffmpegSpeed: null },
    };
  };
  const config = asc ?? [2 << 3 | AAC_RATES.indexOf(rate) >> 1, (AAC_RATES.indexOf(rate) & 1) << 7 | 2 << 3, 0x56, 0xe5, 0x00];
  const audio = convert
    ? { audioCodec: codec, sourceCodec: codec, doTranscode: true, transcodeAudio, audioDecoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: rate } }
    : { audioCodec: 'aac', sourceCodec: 'aac', doTranscode: false, audioDecoderConfig: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: rate, description: Uint8Array.from(config) } };
  const segments = [];
  for (const index of order) {
    current = index;
    const { initSegment, mediaData } = await process({ videoSink: clip.videoSink, audioSink, videoCodec: clip.videoCodec, videoDecoderConfig: clip.videoDecoderConfig, plan, ...audio }, index);
    const played = new Input({ source: new BufferSource(Buffer.concat([initSegment, mediaData])), formats: [MP4] });
    const audioTrack = await played.getPrimaryAudioTrack();
    const frames = [];
    if (audioTrack) {
      const sink = new EncodedPacketSink(audioTrack);
      for (let packet = await sink.getFirstPacket(); packet; packet = await sink.getNextPacket(packet)) {
        // The muxer rewrites each duration to the gap before the next frame, so a frame's own length comes from its
        // payload: a passed-through packet carries it, and a converted or silent frame lasts 1024 samples.
        const data = packet.data.slice();
        const [holds, lasts] = data.length === 8 ? new Float64Array(data.buffer) : data.length === 32 ? new Float64Array(data.buffer, 8) : [];
        frames.push({ at: packet.timestamp, silent: data.join() === SILENT_STEREO_AAC.join(), holds, lasts: data.length === 32 ? lasts : 1024 / rate });
      }
    }
    played.dispose();
    segments[index] = { declaresAudio: audioTrack !== null, format: audioTrack && `${audioTrack.sampleRate} Hz × ${audioTrack.numberOfChannels}`, frames };
  }
  return { plan, segments, runs, reads, trackEnd: track.at(-1).timestamp + track.at(-1).duration };
}

// What playSegments produced, without the lookup counts, to compare two runs.
const output = async (...args) => { const { segments, runs } = await playSegments(...args); return { segments, runs }; };

// Each frame must start where the one before it ends, to within the muxer's one-sample timescale. Played as it is, a
// segment repeats the packet that straddles its start, as playsvideo always has, and the append replaces it; with
// `overlaps`, a frame may also start early, never late.
function assertMeets(frames, what, { overlaps = false } = {}) {
  for (let i = 1; i < frames.length; i++) {
    const [before, frame] = [frames[i - 1], frames[i]];
    if (frame.at === before.at && frame.holds === before.holds) continue;
    const gap = frame.at - (before.at + before.lasts);
    assert.ok(overlaps ? gap < 3e-5 : Math.abs(gap) < 3e-5, `${what} (${frame.at} s)`);
  }
}

test('converted MKV audio meets frame for frame at every segment seam', { timeout: 60000 }, async () => {
  // AC-3 and E-AC-3 are converted to AAC a segment at a time, each segment in its own ffmpeg run. The encoder opens a
  // run with a 1024-sample priming frame and closes it on a window with nothing after it; kept whole and stamped from
  // the run's first packet, every segment opened on that priming, overlapped the tail of the one before, and played
  // audio 21 ms older than its timestamps: a click at each seam, every few seconds of the film.
  const { unpatched, patched } = await segmentProcessors();
  const clip = await demuxFile(fileURLToPath(new URL('./fixtures/h264-aac.mp4', import.meta.url)));
  try {
    const before = (await playSegments(unpatched, clip)).segments.map(segment => segment.frames);
    assert.ok(before.flat().every(frame => frame.at - frame.holds > .02), 'unpatched, every frame must still play audio 21 ms older than its stamp');
    assert.ok(before[1][0].at < before[0].at(-1).at + before[0].at(-1).lasts, 'unpatched, a segment must still overlap the one before');

    // The packet length comes from the codec: 1536 samples for AC-3, stamped unevenly to the millisecond at 44.1 kHz,
    // and what the frame header says for the rest: E-AC-3 in three blocks of 256; E-AC-3 at a reduced rate, where the
    // header has no block count and a frame is always six blocks; AC-3 frames carried in an E-AC-3 track; MPEG-1
    // Layer III and FLAC in blocks of 4096, both at 44.1 kHz. Packets FFmpeg leaves without a duration change nothing.
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    for (const track of [{}, { rate: 44100 }, { codec: 'eac3', size: 768 }, { codec: 'eac3', rate: 24000, header: [0x0b, 0x77, 0, 0, 0xc0, 16 << 3] },
      { codec: 'eac3', header: [0x0b, 0x77, 0, 0, 0x12, 8 << 3] }, { codec: 'mp3', size: 1152, rate: 44100 }, { codec: 'flac', size: 4096, rate: 44100 }, { zeroEvery: 8 }]) {
      const { plan, segments, runs } = await playSegments(patched, clip, track);
      const rate = track.rate ?? 48000, frameSec = 1024 / rate, size = track.size ?? 1536, stepSec = size / gcd(size, 1024) * 1024 / rate;
      const frames = segments.flatMap(segment => segment.frames);
      for (const frame of frames) assert.ok(Math.abs(frame.at - frame.holds) < 1e-6, `the frame at ${frame.at} s must play the audio stamped on it`);
      assertMeets(frames, 'frames must meet with no gap or overlap, seams included');
      for (let index = 1; index < plan.length; index++) {
        const seam = segments[index].frames[0].at;
        assert.ok(seam <= plan[index].startSec && plan[index].startSec - seam < stepSec, 'a segment’s sound must start with its picture or just before it');
        assert.ok(runs[index].start <= seam - 2 * frameSec, 'the encoder must reach the seam on real audio');
        assert.ok(runs[index - 1].end >= seam + 2 * frameSec, 'and the run before it must carry on past the seam');
      }
    }

    // Packets that are not where the grid puts them take their segment, and only that one, back to the old conversion:
    // after a first packet that runs 63 ms, as after a dropped frame, the first segment (the packets after it sit 1 ms
    // off the grid, which it allows); after a stretch shifted by 5 ms, the segments whose conversion reaches into it.
    // Either way no sound goes missing.
    const converted = frame => Math.abs(frame.at - frame.holds - 1024 / 48000) < 1e-6;
    const onGrid = frame => Math.abs(frame.at - frame.holds) < 0.0015;
    const gapped = await playSegments(patched, clip, { stamp: at => at && at + 0.031 });
    assert.ok(gapped.segments[0].frames.every(converted), 'the segment holding the irregular packet must be converted as before');
    assert.ok(gapped.segments.slice(1).every(segment => segment.frames.every(onGrid)), 'the segments after it must be back on the grid');
    assertMeets(gapped.segments.flatMap(segment => segment.frames), 'no sound may be missing where the grid gives way', { overlaps: true });
    const shifted = await playSegments(patched, clip, { stamp: at => at >= 0.1 && at < 0.5 ? at + 0.005 : at });
    assert.ok(shifted.segments[0].frames.every(converted) && shifted.segments[1].frames.every(converted), 'segments reaching the shifted stretch must be converted as before');
    assert.ok(shifted.segments[2].frames.every(onGrid), 'segments clear of it must stay on the grid');
    assertMeets(shifted.segments.flatMap(segment => segment.frames), 'no sound may be missing around the shifted stretch', { overlaps: true });

    // Stamps that jump 10 ms part-way take the segments after the jump off the grid. Their sound starts where the
    // grid cut the one before, so none of it is missing.
    const jumped = await playSegments(patched, clip, { cuts: [0, 0.53, 1.12, 2.6, 3.2], until: 4, end: 4.2, stamp: at => at >= 2.6 ? at + 0.01 : at });
    assert.ok(jumped.segments.slice(0, 3).every(segment => segment.frames.every(frame => Math.abs(frame.at - frame.holds) < 1e-6)), 'the grid must hold before the jump');
    assert.ok(jumped.segments.every(segment => segment.declaresAudio));
    assertMeets(jumped.segments.flatMap(segment => segment.frames), 'no sound may be missing where the grid gives way', { overlaps: true });

    // A first segment shorter than a grid step still carries sound, or the init segment cut from it declares none.
    const short = await playSegments(patched, clip, { cuts: [0, 0.03, 0.56, 1.12] });
    assert.ok(short.segments.every(segment => segment.format === '48000 Hz × 2'), 'every segment, the first included, must declare the soundtrack');
    assertMeets(short.segments.flatMap(segment => segment.frames), 'no sound may be missing around a short first segment', { overlaps: true });
  } finally {
    clip.dispose();
  }
});

test('an MKV whose sound starts after its first segment or ends before its last plays the whole picture', { timeout: 60000 }, async () => {
  // A soundtrack that starts seconds into the film left the first segment with no audio at all. The init segment is
  // cut from that one, so it declared no audio track, and every later segment's append failed and reset the player,
  // over and over. One that ends seconds early handed each segment past its end the soundtrack's last packet, from
  // before the segment, and hls.js dropped the fragment or found it added nothing: the picture stopped where the
  // sound did. Either way the browser plays only where both tracks have data.
  const { unpatched, patched } = await segmentProcessors();
  const clip = await demuxFile(fileURLToPath(new URL('./fixtures/h264-aac.mp4', import.meta.url)));
  try {
    for (const convert of [true, false]) {
      const late = await playSegments(unpatched, clip, { start: 1.2, convert });
      assert.equal(late.segments[0].declaresAudio, false, 'unpatched, a late soundtrack must still leave the first segment without audio');
      const early = await playSegments(unpatched, clip, { end: 0.9, convert });
      assert.ok(early.segments[2].frames.every(frame => frame.at + frame.lasts <= early.plan[2].startSec),
        'unpatched, a segment past an early end must still carry only sound from before it');

      // At 32 kHz a start 9 frames in put the earliest silence a rounding error below zero, which the muxer refuses;
      // at 44.1 kHz an end stamped to the millisecond rounded the silence after it a frame late; a soundtrack whose
      // first packet lies before zero anchors its grid on the first one after; packets without a duration change nothing;
      // a seek can ask for a segment past the end before the one that reaches it; and AAC-LC's config may be bare.
      for (const cut of [{ start: 1.2 }, { start: 1.2, asc: [0x11, 0x90] }, { end: 0.9 }, { start: 0.288, rate: 32000 }, { end: 0.9, rate: 44100 }, { start: -0.016, end: 0.9 }, { end: 0.9, zeroEvery: 8 }, { end: 0.9, order: [0, 2, 1] }]) {
        const rate = cut.rate ?? 48000, frameSec = 1024 / rate;
        const { plan, segments, trackEnd } = await playSegments(patched, clip, { ...cut, convert });
        assert.ok(segments.every(segment => segment.format === `${rate} Hz × 2`), 'every segment must declare the soundtrack as it plays');
        assert.ok(segments.every(({ frames: [first] }, index) => first.at <= plan[index].startSec + 1e-6 || (index === 0 && first.at < frameSec)),
          'each segment’s sound must start with its picture or just before it');
        const frames = segments.flatMap(segment => segment.frames);
        assertMeets(frames, 'frames must meet with no gap or overlap');
        assert.ok(frames.at(-1).at + frames.at(-1).lasts >= 2 - 1e-6, 'sound must run to the end of the picture');
        const silent = frames.filter(frame => frame.silent);
        if (cut.end) assert.ok(silent.length && frames.every(frame => frame.silent === frame.at >= silent[0].at) && Math.abs(silent[0].at - trackEnd) < frameSec,
          'silence must fill exactly the stretch after the soundtrack');
        else assert.ok(frames.every(frame => frame.silent === frame.at < cut.start - 1e-6), 'silence must fill exactly the stretch before the soundtrack');
      }

      // The soundtrack's end is looked up once, by the segment that reaches it: every lookup past it reads the rest of
      // the file in a real MKV, and a segment wholly past it has nothing to find. A short soundtrack after the first
      // segment is not read ahead of the segments that play it.
      const ended = await playSegments(patched, clip, { end: 0.9, convert });
      assert.deepEqual(ended.reads.map(read => read.pastEnd), [0, 1, 0], 'only the segment that reaches the end may look past it');
      assert.equal(ended.reads[2].lookups, 0, 'a segment wholly past the end must look nothing up');
      const straddled = await playSegments(patched, clip, { end: 0.9, cuts: [0, 0.53, 0.92, 1.4], convert });
      assert.deepEqual(straddled.reads.map(read => read.pastEnd), [0, 1, 0, 0], 'a segment whose conversion reaches back over the end must not look past it again');
      const brief = await playSegments(patched, clip, { start: 1.2, end: 1.5, convert });
      assert.equal(brief.reads[0].pastEnd + brief.reads[1].pastEnd, 0, 'the segments before a short soundtrack must not read to its end');
    }

    // Off the grid, here because the last stretch is shifted by 5 ms, the old conversion runs up to a frame past the
    // soundtrack's end; the silence after it must not start before that frame does, or the muxer refuses the segment.
    const offGrid = (await playSegments(patched, clip, { end: 0.9, stamp: at => at >= 0.7 ? at + 0.005 : at })).segments.flatMap(segment => segment.frames);
    const soundEnds = Math.max(...offGrid.filter(frame => !frame.silent).map(frame => frame.at + frame.lasts));
    assert.ok(offGrid.some(frame => frame.silent) && offGrid.filter(frame => frame.silent).every(frame => frame.at >= soundEnds - 1e-6),
      'silence must start after the converted sound ends');

    // Only plain AAC-LC is padded. HE-AAC signalled implicitly reads as AAC-LC, but its config gives it away: HE-AAC v2
    // declares one channel where the file says two, a file may give the output rate where the config gives the core
    // rate, and a backward-compatible config carries its SBR in three more bytes. AAC-LC silence would not decode
    // right in any of them, so they are left as they were.
    for (const heAac of [{ channels: 1 }, { asc: [0x13, 0x10] }, { rate: 24000, asc: [0x13, 0x10, 0x56, 0xe5, 0x98] }]) {
      const track = { start: 1.2, convert: false, ...heAac };
      if (heAac.channels) track.asc = [2 << 3 | 3 >> 1, (3 & 1) << 7 | heAac.channels << 3];
      assert.deepEqual(await output(patched, clip, track), await output(unpatched, clip, track), `${JSON.stringify(heAac)} must get no silence`);
    }
  } finally {
    clip.dispose();
  }
});

test('the bundled audio WASM actually decodes MP3 and produces AAC', { timeout: 30000 }, async () => {
  const wasmBinary = await readFile(new URL('./vendor/ffmpeg-core-audio/ffmpeg-core.wasm', playsvideo));
  // Supply the worker's location to the browser-targeted Emscripten factory;
  // the real shipped WASM executes here, with its bytes supplied from disk.
  globalThis.self = { location: { href: import.meta.url } };
  const core = await createFFmpegCore({ wasmBinary });
  core.FS.writeFile('sfx.mp3', await readFile(new URL('./fixtures/sfx.mp3', import.meta.url)));
  try {
    assert.equal(core.exec('-i', 'sfx.mp3', '-c:a', 'aac', '-f', 'adts', 'output.aac'), 0);
    core.reset();
    const bytes = new Uint8Array(core.FS.readFile('output.aac'));
    assert.ok(bytes.length > 0);
    const input = new Input({ source: new BufferSource(bytes), formats: [ADTS] });
    const track = await input.getPrimaryAudioTrack();
    assert.equal(track.codec, 'aac');
    assert.ok(await track.computeDuration() > .1);
    input.dispose();
  } finally {
    delete globalThis.self;
    core.FS.unlink('sfx.mp3');
    core.FS.unlink('output.aac');
  }
});
