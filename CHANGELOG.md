# Changelog

All notable changes to this project are documented in this file.

Based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org).

## [0.1.2] - 2026-09-23

- Copyright banner in every source and dist file

## [0.1.1] - 2026-09-23

### Breaking

- Dropped the `unpkg` and `jsdelivr` fields, so a bare CDN URL falls through to
  `main` and serves the ES module
- Documented both CDN forms: bare URL for `import`, the `dist/index.global.js`
  path for `importScripts()`

### Bugfix

- A remote method named `catch` or `finally` on a bare handle is not shadowed,
  as an empty chain has nothing to run
- `import` from a bare jsDelivr URL, which used to serve the IIFE build and
  therefore exported nothing

## [0.1.0] - 2026-09-23

- initial version
