// Stamp a fresh ?v= on every script import and data fetch so browsers drop cached copies
// after a release (GitHub Pages lets browsers cache files for 10 minutes).
// Usage: npm run bump
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const version = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
const files = ['index.html', 'app.js', ...readdirSync('lib').map((f) => `lib/${f}`)];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const out = src
    // import ... from './x.js' or './x.js?v=old'
    .replace(/(from\s+'\.{1,2}\/[^'?]+\.js)(\?v=\w+)?'/g, `$1?v=${version}'`)
    // <script ... src="app.js"> and loadLocal('data/x.json')
    .replace(/(src="app\.js)(\?v=\w+)?"/g, `$1?v=${version}"`)
    .replace(/(loadLocal\('data\/[^'?]+\.json)(\?v=\w+)?'/g, `$1?v=${version}'`);
  if (out !== src) writeFileSync(file, out);
}
console.log(`Stamped version ${version}`);
