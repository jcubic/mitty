import { defineConfig } from 'tsup';
import pkg from './package.json';

// The version lives here rather than in the source headers, so releasing never
// means editing five files by hand. esbuild drops ordinary block comments while
// bundling, so this is the banner that actually reaches dist.
const banner = `/*
 * Mitty - use main thread objects from inside a Web Worker (v. ${pkg.version})
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 *
 * ${new Date().toUTCString()}
 */`;

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'iife'],
    globalName: 'Mitty',
    dts: { banner },
    sourcemap: true,
    clean: true,
    banner: { js: banner },
});
