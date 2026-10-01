// Lints the page's inline script and the test files with a pinned ESLint,
// fetched through npx so nothing is added to the project.
// Run with: npm run lint

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractParts, HTML_PATH } from './harness.mjs';

const ESLINT = 'eslint@10.11.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function eslint(args, input){
  const r = spawnSync('npx', ['--yes', ESLINT, '--no-config-lookup', '-c', 'eslint.config.mjs', ...args], {
    cwd: root,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (r.error) throw r.error;
  return r.status;
}

console.log('Linting the inline script of ' + path.relative(root, HTML_PATH));
const pageStatus = eslint(['--stdin', '--stdin-filename', 'kc-snap.inline.js'], extractParts().script);
console.log('Linting tests/ and eslint.config.mjs');
const testStatus = eslint(['tests', 'eslint.config.mjs']);

if (pageStatus === 0 && testStatus === 0) console.log('ESLint: no problems.');
process.exit(pageStatus || testStatus);
