const esbuild = require('esbuild');
const path = require('path');
const { NodeModulesPolyfillPlugin } = require('@esbuild-plugins/node-modules-polyfill');
const { NodeGlobalsPolyfillPlugin } = require('@esbuild-plugins/node-globals-polyfill');

esbuild.build({
  entryPoints: [path.join(__dirname, '../src/ui/paywall.js')],
  bundle: true,
  minify: true,
  outfile: path.join(__dirname, '../src/ui/paywall.bundle.js'),
  format: 'iife',
  target: ['es2020'],
  plugins: [
    NodeModulesPolyfillPlugin(),
    NodeGlobalsPolyfillPlugin({
      process: true,
      buffer: true
    })
  ]
}).then(() => {
  console.log('UI bundled successfully!');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
