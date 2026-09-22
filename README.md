<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/jcubic/mitty/blob/master/.github/logo-dark.svg?raw=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/jcubic/mitty/blob/master/.github/logo-light.svg?raw=true" />
    <img alt="Mitty Logo" src="https://github.com/jcubic/mitty/blob/master/.github/logo-light.svg?raw=true" height="500"/>
  </picture>
</h1>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@jcubic/mitty.svg)](https://www.npmjs.com/package/@jcubic/mitty)
[![github repo](https://img.shields.io/badge/github-repo-orange?logo=github)](https://github.com/jcubic/mitty)
[![CI](https://github.com/jcubic/mitty/actions/workflows/ci.yml/badge.svg)](https://github.com/jcubic/mitty/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/jcubic/mitty/badge.svg)](https://coveralls.io/github/jcubic/mitty)
[![LICENSE MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jcubic/mitty/blob/master/LICENSE)

</div>

## Installation

```bash
npm install @jcubic/mitty
```

## Usage

### ESM / TypeScript

```typescript
import * as mitty from '@jcubic/mitty';
```

### Browser (`<script>` tag)

```html
<script src="https://unpkg.com/@jcubic/mitty/dist/index.global.js"></script>
<script>
  // available as the `Mitty` global
</script>
```

## Origin

The first idea for the mechanism was created for [Hacking Cafe](https://hacking.cafe), a Unix-like environment in the browser. It was then extracted into an NPM library. The name and logo were based on a fictional "Life" magazine worker named [Waleter Mitty](https://en.wikipedia.org/wiki/Walter_Mitty) from the movie ["The Secret Life of Walter Mitty"](<https://en.wikipedia.org/wiki/The_Secret_Life_of_Walter_Mitty_(2013_film)>).

A similar RPC mechanism was created in [Wayne library](https://github.com/jcubic/wayne).

## License

Copyright (c) 2026 [Jakub T. Jankiewicz](https://jakub.jankiewicz.org/)

Released under the MIT License. See [LICENSE](https://github.com/jcubic/mitty/blob/master/LICENSE) for details.
