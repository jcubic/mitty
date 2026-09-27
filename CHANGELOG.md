# Changelog

All notable changes to this project are documented in this file.

Based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org).

## [0.5.0] - 2026-09-27

The wire format is now specified as [RO/RPC 1.0](https://rorpc.org/). Both ends must run 0.5.0.

### Breaking

- Every message carries `"rorpc": "1.0"`. A message without it, or from another major, is refused.
- `__data__` in a marker is an object with named members, not a positional array.
- A 0.4.x peer and a 0.5.0 peer cannot talk to each other in either direction.

### Features

- A host sends a `code` on each error it raises, so a caller can test the cause and not the message.
- A caught error carries that `code`, e.g. `-32601` for a module that does not resolve.
- `stack` is absent when there is none, in place of the `null` the array form needed.
- A handle made for a callback argument now belongs to that call. The host releases it when the call ends.
- A chain cannot read or write `__proto__`, `constructor` or `prototype`. This stops it from reaching a prototype.
- New `get` and `set` options on the host decide which keys a chain may use. Each one answers true or false.
- New exports: `VERSION`, `CODES` and `safe_key`.

### Known limitation

- A callback gets as many arguments as `Function.length` reports. That count stops at the first default.
- Thus an optional parameter keeps its default, and a rest parameter gets nothing. Declare plain parameters.

## [0.4.0] - 2026-09-25

### Features

- `remote.key = value` now sets the property on the host. mitty sends it at once, because an assignment cannot wait.
- New `onerror` option for `connect()`. A failed assignment goes there. The default writes to the console.

### Bugfix

- A request waits for a set that is in flight. A read could pass the write in front of it when `resolve()` was async.
- The reply to a set holds no value. It returned the assigned value, which made a handle that nothing could release.
- A throw from `onerror` no longer leaves a rejection with no handler.
- A host ignores a reply that it hears by chance. Two peers on one bus answered each other without end before this.
- A client ignores a request that it hears by chance. Such a request can hold the same id as a call in progress.
- `remote.name = x` and `remote.length = x` now work. A chain has a function target, and those keys are read-only.

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
