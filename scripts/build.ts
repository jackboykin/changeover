import pkg from '../package.json';

const header = `// ==UserScript==
// @name         Twitch Ad Block
// @namespace    http://tampermonkey.net/
// @version      ${pkg.version}
// @description  ${pkg.description}
// @author       ${pkg.author}
// @match        *://*.twitch.tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
`;

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/../src/twitch-ad-block.user.ts`],
  outdir: `${import.meta.dir}/../dist`,
  target: 'browser',
  banner: header,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
