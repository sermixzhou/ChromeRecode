# Media export dependencies

Pinned to Mediabunny and @mediabunny/aac-encoder 1.65.2 (MPL-2.0).
Upstream: https://github.com/Vanilagy/mediabunny/tree/173f6b70765fa3a6ffc1c82737514416fa559ef5

The AAC fallback contains FFmpeg AAC code (LGPL-2.1-or-later); upstream notices are included.
The AAC, color/alpha merger/splitter and timer worker loaders are adapted by scripts/build-video-export.mjs to load separately packaged local worker files. Their worker bodies are unmodified. The video conversion pump also invokes scripts/pad-mp4-video-tail.mjs before closing MP4 video, to hold a final captured frame across a short audio/video end-time difference. Missing decoded source frames still raise an encoding error. No code or media is fetched from the network at runtime.

Readable upstream sources are included here. Rebuild the local workers with npm ci and npm run build:export.
