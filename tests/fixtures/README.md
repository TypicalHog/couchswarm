# Synthetic media fixtures

`h264-aac.mp4` is the 98,839-byte `codec-h264-baseline.mp4` fixture from [playsvideo](https://github.com/kzahel/playsvideo), downloaded from [this source](https://raw.githubusercontent.com/kzahel/playsvideo/main/tests/fixtures/codec-h264-baseline.mp4).

Its [generator](https://github.com/kzahel/playsvideo/blob/main/tests/fixtures/generate-codec-matrix.sh) creates two seconds of FFmpeg test patterns and sine audio. It is synthetic footage from an MIT-licensed project. The test repeats its encoded packets into an MKV in memory, then exercises range-based indexing and remuxing into playable MP4 segments.

`sfx.mp3` is a 3,213-byte generated 480 Hz sine-wave fixture from [Web Platform Tests](https://github.com/web-platform-tests/wpt/blob/master/webcodecs/README.md), downloaded from [this source](https://raw.githubusercontent.com/web-platform-tests/wpt/master/webcodecs/sfx.mp3). It exercises the shipped WASM MP3 decoder and AAC encoder. WPT uses BSD-3-Clause; copies of both upstream licenses are alongside these fixtures.
