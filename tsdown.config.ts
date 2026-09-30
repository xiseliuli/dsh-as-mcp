import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-as-mcp',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
})
