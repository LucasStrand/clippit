// Builds Clippit Says No into build/safari and build/chromium (for Chrome, Brave, Edge and friends).
// Started from Consent-O-Matic's webpack config. On top of it: one manifest for both browsers, all rules
// merged into a bundled rules.json (rules/ from Consent-O-Matic, plus rules-clippit/ if it exists), and Clippy's
// face as the icon when Clippit's frames have been decoded (npm run setup in the Clippit folder).
const HtmlMinimizerPlugin = require("html-minimizer-webpack-plugin");
const { Compilation, sources } = require("webpack");
const PACKAGE = require('./package.json');
const fs = require('fs');
const path = require('path');
const glob = require("glob");

// Forward slashes in, absolute paths out, so the patterns and the entries work on Windows too.
const find = pattern => glob.sync(pattern.replace(/\\/g, '/'), { absolute: true });

const CLIPPY = path.join(__dirname, '..', 'app', 'assets', 'clippy', 'icon-256.png');
const icon = size => fs.existsSync(CLIPPY) ? CLIPPY : path.join(__dirname, 'src', `icon_${size}.png`);

function manifest(target) {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  m.version = PACKAGE.version;
  // Safari runs MV3 background pages as non-persistent scripts; Chromium wants a service worker.
  if (target !== 'safari') m.background = { service_worker: 'service.js' };
  return m;
}

function rules() {
  const merged = {};
  for (const dir of ['rules', 'rules-clippit']) {
    for (const f of find(path.join(__dirname, dir, '*.json')).sort()) {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      delete r.$schema;
      Object.assign(merged, r);
    }
  }
  return merged;
}

// Writes manifest.json, rules.json, the icons and the popup logo next to the bundles.
class ExtrasPlugin {
  constructor(target) { this.target = target; }
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('extras', comp => {
      comp.hooks.processAssets.tap({ name: 'extras', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, () => {
        comp.emitAsset('manifest.json', new sources.RawSource(JSON.stringify(manifest(this.target), null, 2)));
        comp.emitAsset('rules.json', new sources.RawSource(JSON.stringify(rules())));
        for (const size of [48, 96, 128]) comp.emitAsset(`icon_${size}.png`, new sources.RawSource(fs.readFileSync(icon(size))));
        comp.emitAsset('logo.png', new sources.RawSource(fs.readFileSync(icon(128))));
      });
    });
  }
}

module.exports = env => ({
  mode: 'production',
  entry: {
    service: ['./src/background.js'],
    content: [
      './src/contentScript.js',
      "./src/content.scss",
      ...find(__dirname + "/src/*.svg")
    ],
    ui: [
      './src/options.js',
      './src/popup.js',
      './src/ui.scss',
      ...find(__dirname + "/src/*.html")
    ],
    editor: [
      ...find(__dirname + "/src/editor/js/*.js"),
      './src/editor/scss/main.scss',
      ...find(__dirname + "/src/editor/*.html")
    ]
  },
  output: {
    publicPath: "",
    filename: '[name].js',
    path: path.resolve(__dirname, 'build', env.target),
    clean: true
  },
  module: {
    parser: { javascript: { exportsPresence: "error", importExportsPresence: "error" } },
    rules: [
      { test: /\.(png|json|svg|html)/, type: 'asset/resource', generator: { filename: '[name][ext]' } },
      { test: /\.(sc|sa)ss$/i, type: 'asset/resource', use: ["sass-loader"], generator: { filename: '[name].css' } },
    ]
  },
  optimization: { minimize: true, minimizer: ['...', new HtmlMinimizerPlugin()] },
  plugins: [new ExtrasPlugin(env.target)],
});
