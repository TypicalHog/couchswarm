# Synthetic media fixtures

`h264-aac.mp4` is the 98,839-byte `codec-h264-baseline.mp4` fixture from [playsvideo](https://github.com/kzahel/playsvideo), downloaded from [this source](https://raw.githubusercontent.com/kzahel/playsvideo/65cdd401476c687930a076cc4872e0f860cb8561/tests/fixtures/codec-h264-baseline.mp4). Its SHA-256 is `6e3b7e016dc5651479a2073bf78a25b09616daa6db01c9132ddc0847fc7e77a6`.

Its [generator](https://github.com/kzahel/playsvideo/blob/main/tests/fixtures/generate-codec-matrix.sh) creates two seconds of FFmpeg test patterns and sine audio. It is synthetic footage from an MIT-licensed project. The test repeats its encoded packets into an MKV in memory, then exercises range-based indexing and remuxing into playable MP4 segments.

`sfx.mp3` is a 3,213-byte generated 480 Hz sine-wave fixture from [Web Platform Tests](https://github.com/web-platform-tests/wpt/blob/master/webcodecs/README.md), downloaded from [this source](https://raw.githubusercontent.com/web-platform-tests/wpt/5d07d9b645734ba9c10700b9949fefd2566a798b/webcodecs/sfx.mp3). Its SHA-256 is `f191b966413f332f16a7df1ece77b128f1618cce7f2924d1a0efb60b6c9410ca`. It exercises the shipped WASM MP3 decoder and AAC encoder. WPT uses BSD-3-Clause; copies of both upstream licenses are alongside these fixtures.
