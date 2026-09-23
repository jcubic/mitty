# Changelog

All notable changes to this project are documented in this file.

Based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org).

## [0.3.0] - 2026-09-23

### Breaking

- The host sends a handle for each value that has methods. A `serialize()` hook is not necessary.
- A class instance is now a handle, not a copy. Use `await` to read its data.
- `serialize()` decides a value only when it returns a different value. If it does not, `remote` decides.

### Features

- New `remote` option. It selects the values that stay on the host. The default is `has_methods`.
- The package exports `has_methods()`. Use it in your own `remote` function.

## [0.2.0] - 2026-09-23

### Breaking

- The markers on the wire are now `{ __type__, __data__ }`. A normal object does not collide with them.
- Use the same version on the two ends. A 0.1.x worker cannot read the markers of a 0.2.x host.

### Bugfix

- The banner in `dist` is now a legal comment. A minifier keeps it.

## [0.1.2] - 2026-09-23

- Each source file and each `dist` file has a copyright banner.

## [0.1.1] - 2026-09-23

### Breaking

- The `unpkg` and `jsdelivr` fields are removed. A bare CDN URL now gives the ES module.
- The README shows two CDN forms: a bare URL for `import`, `dist/index.global.js` for `importScripts()`.

### Bugfix

- A remote method with the name `catch` or `finally` works on a bare handle. An empty chain has no operation.
- `import` from a bare CDN URL works. Before, the URL gave the IIFE build, which has no exports.

## [0.1.0] - 2026-09-23

- First version.
