// Bundles @gbgplc/smartcapture-web and its npm dependencies into one ES module, and copies the SDK's
// document worker next to it. Output goes straight into the page's sdk/ folder.
//
// Do not minify or otherwise transform the output: the SDK's obfuscated code has anti-tamper checks and
// freezes the page if it is rewritten.
import { build } from 'rolldown';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';

const pkgDir = 'node_modules/@gbgplc/smartcapture-web';
const outDir = '../../sdk';
const { version } = JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8'));

// Virtual entry: re-export the SDK, plus its version so the page can show which build it loaded.
const ENTRY = '\0sdk-entry';
await build({
  input: ENTRY,
  platform: 'browser',
  plugins: [{
    name: 'sdk-entry',
    resolveId: id => (id === ENTRY ? id : null),
    load: id => (id === ENTRY ? `export * from '@gbgplc/smartcapture-web';\nexport const version = ${JSON.stringify(version)};\n` : null),
  }],
  output: { file: `${outDir}/smartcapture.esm.js`, format: 'esm', minify: false, codeSplitting: false },
  logLevel: 'warn',
});

// Loaded at runtime via new URL('./smart-capture/SmartCaptureWorker.js', import.meta.url); copy it verbatim.
mkdirSync(`${outDir}/smart-capture`, { recursive: true });
cpSync(`${pkgDir}/dist/lib/smart-capture/SmartCaptureWorker.js`, `${outDir}/smart-capture/SmartCaptureWorker.js`);
console.log(`Built SDK ${version} into ${outDir}/`);
