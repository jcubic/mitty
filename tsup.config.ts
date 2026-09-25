import { defineConfig } from 'tsup';
import pkg from './package.json';

// The version lives here rather than in the source headers, so releasing never
// means editing five files by hand. esbuild drops ordinary block comments while
// bundling, so this is the banner that actually reaches dist.
//
// It has to open with `/*!` and name `@license`: that is what marks a comment
// as legal, and legal comments are the only ones a minifier keeps. jsDelivr
// re-minifies with Terser when serving an unminified file, and anyone bundling
// mitty will minify it too - a plain `/*` banner is silently dropped by both.
// The source headers stay plain on purpose, so esbuild strips them instead of
// stacking five copies on top of every bundle.
const banner = `/*!
 * Mitty - use main thread objects from inside a Web Worker (v. ${pkg.version})
 *
 * Copyright (c) 2026 Jakub T. Jankiewicz <https://jakub.jankiewicz.org>
 * Released under MIT license
 * @license MIT
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
    banner: { js: banner }
});
