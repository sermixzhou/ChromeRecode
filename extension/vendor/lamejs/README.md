# lamejs 1.2.1

MP3 encoding uses the unmodified browser build of **lamejs**, Alex Zhukov's JavaScript port of the LAME MP3 encoder.

- Upstream: https://github.com/zhuker/lamejs
- LAME: https://lame.sourceforge.net/
- Distribution: https://registry.npmjs.org/lamejs/-/lamejs-1.2.1.tgz
- Upstream package license: LGPL-3.0. See `LGPL-3.0.txt`, `GPL-3.0.txt`, the upstream `LICENSE` notice, and `COPYING.upstream`.

`lame.min.js` is shipped as a separate, unmodified file and imported by `mp3-worker.js`. It is not merged into application code and can be replaced by a compatible build. All encoding runs locally, with no CDN or remote code requests.

`source.tar.gz` contains the matching unmodified JavaScript sources, the readable browser build `lame.all.js`, upstream build scripts, package metadata and README. The readable build can also replace `lame.min.js` without changes to the application. No library source changes have been made.

SHA-256 of `lame.min.js`: `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`.

The GPL / LGPL version 3 license texts are reproduced from the SPDX license list (`spdx-license-list` 6.12.0). `COPYING.upstream` preserves the older license text shipped in the original package's Java sources.
