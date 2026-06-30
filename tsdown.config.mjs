import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'cjs',
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' })
})
