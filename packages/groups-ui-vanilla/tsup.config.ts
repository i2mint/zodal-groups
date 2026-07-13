import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  loader: { '.css': 'copy' },
  publicDir: false,
  onSuccess: 'cp src/styles.css dist/styles.css',
});
