import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const headerPath = join(import.meta.dir, '../src/header.txt');
const compiledPath = join(import.meta.dir, '../dist/twitch-ad-block.user.js');
const packageJsonPath = join(import.meta.dir, '../package.json');

const header = readFileSync(headerPath, 'utf-8');
const compiled = readFileSync(compiledPath, 'utf-8');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
const version = packageJson.version ?? '0.0.0';

writeFileSync(compiledPath, (header + '\n' + compiled).replaceAll('__VERSION__', version), 'utf-8');

console.log('Header added to compiled userscript');
