#!/usr/bin/env node
/**
 * tools/mode.mjs — 薄壳，复用 tools/pilot/mode.mjs。
 * 文档里的 `node tools/mode.mjs ...` 与 `node tools/pilot/mode.mjs ...` 等价。
 */
import { runCli } from './pilot/mode.mjs';

runCli()
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
