import { relative } from 'node:path';
import pkg from '../package.json';

const header = `// ==UserScript==
// @name         Changeover
// @namespace    ${pkg.homepage}
// @version      ${pkg.version}
// @description  ${pkg.description}
// @author       ${pkg.author}
// @homepageURL  ${pkg.homepage}
// @supportURL   ${pkg.homepage}/issues
// @downloadURL  ${pkg.homepage}/releases/latest/download/changeover.user.js
// @match        *://*.twitch.tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
`;

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/changeover.user.ts`],
  outdir: `${import.meta.dir}/../dist`,
  target: 'browser',
  banner: header,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const { path, size } of result.outputs) {
  console.log(`${relative(process.cwd(), path)}  ${(size / 1024).toFixed(1)} KB`);
}
