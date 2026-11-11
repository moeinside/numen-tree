/**
 * Pilot run 主循环（MVP）
 *
 * 流程：
 *   enterDev lease（mode 互斥）→ 确认树未运行 → clear locks → client → fixture(可选)
 *   → observe/decide/approve/act → caps/ownership/fencing → settle → exitDev
 */
import { createNumenClient } from './numen-client.mjs';
import { createRun, appendJsonl, logConsole, finishRun, writeReport, saveManifest, archiveRun } from './run-store.mjs';
import { createCaps } from './caps.mjs';
import { createProvider } from './llm-provider.mjs';
import { approveAction } from './approval.mjs';
import { newOwner, readLock } from './lock.mjs';
import { enterDev, exitDev, heartbeatLease } from './mode.mjs';
import { isPortOpen, treeStatus, clearLocks, patchStatus } from './tree-control.mjs';
import { applyFixture } from './fixture.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OBSERVE_LUA = `local ok,s=pcall(numen.status.self)
if not ok then return "ERR:"..tostring(s) end
local p=s.pos or {}
return string.format("hp=%s food=%s pos=%s,%s,%s",
  tostring(s.hp), tostring(s.food or s.hunger),
  tostring(p.x), tostring(p.y), tostring(p.z))`;

function compactObservation(obs) {
  if (!obs) return null;
  const cut = (s, n) => String(s ?? '').slice(0, n);
  return {
    companions: cut(obs.companions, 600),
    events: cut(obs.events, 1500),
    self: cut(obs.self, 300),
    error: obs.error ?? null,
  };
}

function firstCompanion(text) {
  const m = String(text ?? '').match(/^-\s+([^\s(]+)/m);
  return m ? m[1] : null;
}

export async function runPilot(opts = {}) {
  const {
    minutes = 20,
    steps = 200,
    maxTokens = 200_000,
    provider = 'mock',
    companion: requestedCompanion = null,
    dryRun = false,
    approve = 'each',
    noLock = false,
    noHandoff = false,
    protect = false,
    protectReason = null,
    fixture = null,
    allowCreative = false,
    restoreTree = false,
    outDir = null,
    observeLua = true,
    targetFile = null,
    targetLua = null,
    mode = fixture ? 'dev-cheat' : 'reference-pilot',
  } = opts;

  const caps = createCaps({ steps, minutes, maxTokens });
  const run = createRun({
    mode,
    provider,
    companion: requestedCompanion,
    caps: { steps, minutes, maxTokens },
    dryRun,
    outDir,
  });
  logConsole(run.files.console, `run start ${run.runId} mode=${mode} provider=${provider} dryRun=${dryRun}`);

  let targetCode = targetLua || null;
  if (targetFile) {
    targetCode = fs.readFileSync(targetFile, 'utf8');
    run.manifest.targetFile = path.resolve(targetFile);
  }
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    console.error('[pilot] SIGINT: stopping after current call');
  };
  process.once('SIGINT', onSigint);

  let owner = null;
  let fencing = null;
  let client = null;
  let exitCode = 0;
  let lastResult = null;
  let tokens = 0;
  let llmCalls = 0;
  let repeatedObservations = 0;
  let lastObsHash = null;
  const history = [];

  try {
    // 1) mode dev lease（lease + fencing；树活着时拒绝，不驱逐树）
    if (!noLock) {
      owner = newOwner('pilot');
      const dev = await enterDev({
        owner,
        runId: run.runId,
        mode,
        ttlMs: 30_000,
        protect,
        protectReason,
        actor: owner,
      });
      if (!dev.ok) throw new Error(`dev lease failed: ${dev.code}: ${dev.error}`);
      fencing = dev.fencing;
      run.manifest.owner = owner;
      run.manifest.fencing = fencing;
      run.manifest.protected = !!protect;
      saveManifest(run);
      logConsole(run.files.console, `dev lease acquired ${owner} fencing=${fencing}`);
    }

    // 2) 树必须不在跑；不在跑才清僵尸锁。绝不 handoff 驱逐树。
    if (!noHandoff) {
      const before = await treeStatus();
      if (before.listening) {
        throw new Error('tree_active: tree is listening; use mode force-dev if Lead approves');
      }
      const cl = await clearLocks();
      logConsole(run.files.console, `clearLocks (patch): ${JSON.stringify(cl).slice(0, 300)}`);
      run.manifest.patch = await patchStatus();
    } else {
      const before = await treeStatus();
      if (before.listening) throw new Error('--no-handoff used while tree is listening');
    }

    // 3) connect after tree released
    client = await createNumenClient({ timeoutMs: 120_000 });
    const tools = await client.toolsList();
    run.manifest.numenTools = tools.map((t) => t.name);
    saveManifest(run);

    const list = await client.listCompanions();
    const companion = requestedCompanion || firstCompanion(list.text);
    if (!companion) throw new Error('no companion found');
    run.manifest.companion = companion;
    saveManifest(run);
    logConsole(run.files.console, `companion=${companion}`);

    // 4) fixture（仅 RUNNING 前）
    if (fixture) {
      const fx = await applyFixture({
        kind: fixture,
        client,
        companion,
        allowCreative,
      });
      appendJsonl(run.files.raw, {
        at: new Date().toISOString(),
        kind: 'fixture',
        fixture,
        ok: fx.ok,
        text: fx.tool?.text ?? fx.error,
      });
      if (fx.ok) run.manifest.cheatCount += 1;
      saveManifest(run);
      if (!fx.ok) throw new Error(`fixture failed: ${fx.error}`);
    }

    // 5) provider
    const brain = createProvider(provider);

    // 6) loop
    while (true) {
      const cap = caps.check({ stepsUsed: run.manifest.steps, tokens });
      if (!cap.ok) {
        run.manifest.abortReason = cap.reason;
        logConsole(run.files.console, `cap: ${cap.reason}`);
        break;
      }

      // ownership: tree must not reappear
      if (await isPortOpen(8767)) {
        run.manifest.abortReason = 'tree_reappeared';
        logConsole(run.files.console, 'tree port 8767 reappeared; abort');
        break;
      }
      // lock ownership + fencing（被 force 接管后旧进程不能继续动作）
      if (!noLock) {
        const hb = heartbeatLease({
          owner,
          fencing,
          ttlMs: 30_000,
          protectTtlMs: protect ? 600_000 : null,
        });
        if (!hb.ok) {
          run.manifest.abortReason = `lock_lost:${hb.code || 'lost'}`;
          logConsole(run.files.console, `lease lost (${hb.code}: ${hb.error}); abort`);
          break;
        }
      }

      // observation
      let obs = null;
      try {
        const lc = await client.listCompanions();
        const ev = await client.getEvents(companion);
        let self = null;
        if (observeLua) {
          self = await client.callTool('lua', { companion, code: OBSERVE_LUA });
        }
        obs = {
          companions: lc.text,
          events: ev.text,
          self: self?.text ?? null,
          at: new Date().toISOString(),
        };
        const hash = crypto
          .createHash('sha256')
          .update(JSON.stringify(compactObservation(obs)))
          .digest('hex');
        obs.hash = hash;
        obs.unchanged = lastObsHash === hash;
        if (obs.unchanged) repeatedObservations += 1;
        lastObsHash = hash;
        appendJsonl(run.files.observations, { kind: 'observe', ...obs });
        if (self?.text) {
          console.log(
            `[obs${obs.unchanged ? ' unchanged' : ''}] ${String(self.text).replace(/\s+/g, ' ').slice(0, 240)}`,
          );
        }
      } catch (e) {
        obs = { error: String(e?.message ?? e) };
        appendJsonl(run.files.observations, { kind: 'observe_error', ...obs });
        console.log(`[obs] error ${obs.error}`);
      }

      // target predicate: 达标立即退出，不把决策权全交给 LLM
      if (targetCode) {
        try {
          const t = await client.callTool('lua', { companion, code: targetCode });
          appendJsonl(run.files.observations, {
            kind: 'target_check',
            text: t.text,
          });
          const reached = /returned:\s*(true|1)\b/i.test(t.text) || /\btrue\b/i.test(t.text);
          if (reached) {
            run.manifest.abortReason = 'target_reached';
            console.log('[target] reached; stopping');
            break;
          }
        } catch (e) {
          appendJsonl(run.files.observations, {
            kind: 'target_error',
            error: String(e?.message ?? e),
          });
        }
      }
      if (interrupted) {
        run.manifest.abortReason = 'sigint';
        break;
      }

      // decide
      let action;
      let actionFromProvider = false;
      try {
        llmCalls += 1;
        const decision = await brain.decide({
          companion,
          step: run.manifest.steps,
          observation: compactObservation(obs),
          lastResult,
          history,
        });
        action = decision;
        actionFromProvider = !!(decision && decision.action);
      } catch (e) {
        action = { action: 'stop', reason: `provider_error:${String(e?.message ?? e)}` };
      }
      if (!action || !action.action) action = { action: 'stop', reason: 'invalid_action' };
      appendJsonl(run.files.actions, {
        at: new Date().toISOString(),
        step: run.manifest.steps,
        action,
      });
      logConsole(run.files.console, `step ${run.manifest.steps} action=${action.action}`);

      if (action.action === 'stop') {
        run.manifest.abortReason = action.reason || 'stop';
        // LLM/provider 主动 stop 是正常收口；provider_error/invalid_action 不是。
        run.manifest.llmStop = actionFromProvider;
        lastResult = { action: 'stop', ok: true };
        break;
      }

      // approval
      let approved;
      try {
        approved = await approveAction(action, { mode: approve });
      } catch (e) {
        run.manifest.abortReason = `approval_error:${String(e?.message ?? e)}`;
        break;
      }
      if (!approved.ok) {
        run.manifest.abortReason = 'approval_denied';
        break;
      }
      if (!approved.auto) run.manifest.approvals += 1;

      // execute
      let result;
      try {
        if (dryRun && !['observe', 'get_events', 'wait'].includes(action.action)) {
          result = { ok: true, dryRun: true, action: action.action };
        } else if (action.action === 'observe') {
          result = { ok: true, noop: true };
        } else if (action.action === 'get_events') {
          result = await client.getEvents(companion);
        } else if (action.action === 'lua') {
          if (!action.code) throw new Error('lua action missing code');
          result = await client.callTool('lua', { companion, code: String(action.code) });
        } else if (action.action === 'skill') {
          if (!action.skill) throw new Error('skill action missing skill');
          result = await client.callTool('skill', { companion, skill: String(action.skill) });
        } else if (action.action === 'say') {
          result = await client.callTool('say', {
            companion,
            text: String(action.text ?? ''),
          });
        } else if (action.action === 'wait') {
          await sleep(Math.min(5000, Math.max(0, Number(action.ms) || 1000)));
          result = { ok: true, waited: true };
        } else {
          throw new Error(`unknown action: ${action.action}`);
        }
      } catch (e) {
        result = { ok: false, error: String(e?.message ?? e) };
      }
      if (action.usage?.total_tokens) tokens += Number(action.usage.total_tokens);
      run.manifest.tokens = tokens;
      run.manifest.llmCalls = llmCalls;
      run.manifest.repeatedObservations = repeatedObservations;

      lastResult = {
        action: action.action,
        ok: result.ok !== false,
        isError: result.isError,
        text: String(result.text ?? result.error ?? '').slice(0, 2000),
        dryRun: !!result.dryRun,
      };
      appendJsonl(run.files.raw, {
        at: new Date().toISOString(),
        kind: 'step',
        step: run.manifest.steps,
        action,
        result: lastResult,
      });
      console.log(
        `[step ${run.manifest.steps}] ${action.action} ${lastResult.ok ? 'ok' : 'FAIL'} ${lastResult.text.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      history.push({ step: run.manifest.steps, action: action.action, ok: lastResult.ok });
      run.manifest.steps += 1;
      saveManifest(run);

      if (!lastResult.ok && !result.isError) {
        // 执行异常（非工具错误）直接停
        run.manifest.abortReason = `action_error:${lastResult.text}`;
        break;
      }
    }

    // settle (read-only wait)
    await sleep(500);
    try {
      const ev = await client.getEvents(companion);
      appendJsonl(run.files.raw, { at: new Date().toISOString(), kind: 'settle', events: ev.text });
    } catch { /* ignore */ }
  } catch (e) {
    run.manifest.abortReason = `error:${String(e?.message ?? e)}`;
    logConsole(run.files.console, `error: ${String(e?.stack ?? e)}`);
    exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (client) {
      try { await client.getEvents(run.manifest.companion || ''); } catch { /* ignore */ }
    }
    if (owner) {
      const cur = readLock();
      if (cur && cur.owner === owner) {
        const r = await exitDev({ owner, fencing, actor: owner });
        logConsole(run.files.console, `dev lease release: ${JSON.stringify(r)}`);
      } else {
        logConsole(run.files.console, 'dev lease already lost; nothing to release');
      }
    }
    if (restoreTree) {
      const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'tree-start.mjs')], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      p.unref();
      logConsole(run.files.console, `restoreTree via tree-start spawned pid=${p.pid}`);
    }
    run.manifest.tokens = tokens;
    run.manifest.llmCalls = llmCalls;
    run.manifest.repeatedObservations = repeatedObservations;
    finishRun(run);
    writeReport(run, {
      lines: [
        `- abort: ${run.manifest.abortReason ?? 'none'}`,
        `- exitCode: ${exitCode}`,
      ],
    });
    const archived = archiveRun(run);
    const archiveLine = `archive: ${JSON.stringify(archived)}`;
    logConsole(run.files.console, archiveLine);
    if (archived.ok) {
      // 归档在写这条日志之前发生；补进归档副本，保证 console 原样。
      try {
        fs.appendFileSync(
          path.join(archived.dest, 'console.log'),
          `[${new Date().toISOString()}] ${archiveLine}\n`,
        );
      } catch { /* archive 已成功；补日志失败不改变结果 */ }
    }
    console.log(JSON.stringify({
      ok:
        exitCode === 0 &&
        (run.manifest.llmStop === true ||
          !run.manifest.abortReason ||
          ['target_reached', 'stop', 'max_steps', 'max_minutes', 'max_tokens'].includes(
            run.manifest.abortReason,
          )),
      runId: run.runId,
      dir: run.dir,
      steps: run.manifest.steps,
      abortReason: run.manifest.abortReason,
      files: run.files,
      exitCode,
    }, null, 2));
  }
  return { exitCode, run };
}
