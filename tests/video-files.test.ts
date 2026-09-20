import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMkv, videoFiles } from '../lib/video-files.ts';
import { videoFiles as helperVideoFiles } from '../helper/torrent-helper.mjs';
import { MAX_HELPER_PEERS, MAX_SEATS } from '../lib/sync.ts';
import { MAX_HELPER_PEERS as helperPeers, MAX_SEATS as helperSeats } from '../helper/constants.mjs';

test('MKV torrents select the main movie and retain other video choices', () => {
  const files = [
    { name: 'sample.mp4', path: 'sample.mp4', length: 10 },
    { name: 'Movie.MKV', path: 'Movie.MKV', length: 1000 },
    { name: 'poster.jpg', path: 'poster.jpg', length: 2000 },
    { name: 'Movie.mkv.txt', path: 'Movie.mkv.txt', length: 3000 },
  ];
  assert.deepEqual(videoFiles(files).map(file => file.name), ['Movie.MKV', 'sample.mp4']);
  assert.equal(files[0].name, 'sample.mp4', 'selection must not reorder the torrent metadata');
  assert.equal(isMkv('Movie.MKV'), true);
  assert.equal(isMkv('Movie.mkv.txt'), false);
});

test('existing MP4, WebM, M4V and OGV videos keep their selection order', () => {
  const files = ['video.mp4', 'video.webm', 'video.m4v', 'video.ogv'].map((name, i) => ({ name, path: name, length: 40 - i }));
  assert.deepEqual(videoFiles(files), files);
  assert.equal(isMkv('video.mp4'), false);
});

test('the packaged helper and the site select the same video files', () => {
  const files = [{ name: 'sample.mp4', path: 'r/sample.mp4', length: 10 }, { name: 'Movie.MKV', path: 'r/Movie.MKV', length: 1000 }, { name: 'poster.jpg', path: 'r/poster.jpg', length: 2000 }, { name: 'clip.ogv', path: 'r/clip.ogv', length: 10 }];
  assert.deepEqual(helperVideoFiles(files), videoFiles(files));
  const ties = ['A.mkv', 'Zebra.mkv', 'Ärger.mkv'].map(name => ({ name, path: name, length: 40 }));
  assert.deepEqual(videoFiles(ties).map(file => file.name), ['A.mkv', 'Zebra.mkv', 'Ärger.mkv'], 'equal lengths tie-break on code units, not on the runner locale');
  assert.deepEqual(helperVideoFiles(ties), videoFiles(ties));
  // The helper reads the same torrent through parse-torrent, which joins nested paths with the Windows separator.
  const nested = [{ name: 'A.mkv', path: 'Pack/A.mkv', length: 40 }, { name: 'PackA.mkv', path: 'PackA.mkv', length: 40 }];
  const windows = nested.map(file => ({ ...file, path: file.path.replaceAll('/', '\\') }));
  assert.deepEqual(helperVideoFiles(windows).map(file => file.name), videoFiles(nested).map(file => file.name),
    'a backslash path ties the same way the browser ties the forward-slash one');
});

test('the packaged helper and the site agree on the seat count', () => assert.equal(helperSeats, MAX_SEATS));

test('the packaged helper and the site agree on how many viewers one helper answers', () => assert.equal(helperPeers, MAX_HELPER_PEERS));
