# Changelog

All notable changes to this project are documented in this file.

Based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org).

## [0.1.1] - 2026-09-23

### Added

- `catch()` and `finally()` on a remote chain, so a pending chain acts like a promise, not a recorded property
- `./dist/*` and `./package.json` subpath exports, so bundlers can reach the IIFE build that CDNs already serve
- README note that `importScripts()` from a Blob worker needs an absolute URL, because a `blob:` URL has an opaque path
- README note that there is no fire-and-forget: a call that is never awaited is never sent, silently and without error

### Changed

- Dropped the `unpkg` and `jsdelivr` fields, so a bare CDN URL falls through to `main` and serves the ES module
- Documented both CDN forms: bare URL for `import`, the `dist/index.global.js` path for `importScripts()`

### Fixed

- A remote method named `catch` or `finally` on a bare handle is not shadowed, as an empty chain has nothing to run
- `import` from a bare jsDelivr URL, which used to serve the IIFE build and therefore exported nothing

## [0.1.0] - 2026-09-23

- initial version
