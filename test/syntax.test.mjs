// Every source and test file must at least parse. The unit tests only cover
// files they import; a module nobody imports would rot silently without this.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const roots = ['src', 'test'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(mjs|js)$/.test(name)) files.push(path);
  }
};
for (const root of roots) walk(root);

for (const file of files) {
  test(`parses: ${file}`, () => {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  });
}
