#!/usr/bin/env node
/**
 * Bundles the userscript sources into a single .user.js file.
 *
 * esbuild is already a transitive dependency of the extension's toolchain, so
 * no new dependency is introduced. The output is an IIFE with the Tampermonkey
 * metadata block prepended.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(rootDir, '..');
const outFile = resolve(repoRoot, 'userscript/dist/deepseek-pp.user.js');

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const version = packageJson.version ?? '0.0.0';

const METADATA = `// ==UserScript==
// @name         DeepSeek++ 记忆与个性化
// @name:en      DeepSeek++ Memory & Personalization
// @namespace    https://github.com/zhu1090093659/deepseek-pp
// @version      ${version}
// @description  为 DeepSeek 网页版添加跨对话长期记忆、系统提示词预设、项目上下文和 /skill 提示词片段（DeepSeek++ 浏览器扩展的油猴脚本移植版）
// @description:en  Long-term cross-conversation memory, system prompt presets, project context and /skill snippets for DeepSeek web (userscript port of the DeepSeek++ extension)
// @author       DeepSeek++ contributors
// @license      Apache-2.0
// @homepageURL  https://github.com/zhu1090093659/deepseek-pp
// @supportURL   https://github.com/zhu1090093659/deepseek-pp/issues
// @match        https://chat.deepseek.com/*
// @icon         https://chat.deepseek.com/favicon.svg
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// ==/UserScript==

`;

async function main() {
  const result = await build({
    entryPoints: [resolve(rootDir, 'src/main.ts')],
    bundle: true,
    format: 'iife',
    target: ['chrome100', 'firefox100', 'safari15'],
    platform: 'browser',
    // Keep the output readable: a userscript is reviewed by users and by
    // Greasy Fork moderators, and minified code is often rejected there.
    minify: false,
    legalComments: 'none',
    write: false,
    charset: 'utf8',
  });

  const [output] = result.outputFiles;
  if (!output) throw new Error('esbuild produced no output');

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, METADATA + output.text, 'utf8');

  const sizeKb = (Buffer.byteLength(METADATA + output.text) / 1024).toFixed(1);
  console.log(`Built ${outFile} (${sizeKb} kB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
