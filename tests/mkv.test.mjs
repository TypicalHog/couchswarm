import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BufferSource, BufferTarget, EncodedAudioPacketSource, EncodedVideoPacketSource, Input, MP4, ADTS, MkvOutputFormat, Output } from 'mediabunny';
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
