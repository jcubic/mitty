import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'iife'],
    globalName: 'Mitty',
    dts: true,
    sourcemap: true,
    clean: true,
});
