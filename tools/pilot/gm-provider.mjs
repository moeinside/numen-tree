/**
 * GMProvider — tool-side client for the dev-only GM command portal.
 *
 * Hard requirements:
 * - loopback only by default (the mod binds 127.0.0.1:8770);
 * - every request carries runId, reason and selfChallenge;
 * - failures are structured ({ok:false,error:{code,message}}), never thrown for
 *   HTTP/policy errors;
 * - optional gm.jsonl journal entry carries assisted:true and never the token.
 *
 * This module never starts, installs, restarts or kills the game. It only
 * speaks HTTP to a portal the operator explicitly enabled.
 */
import fs from 'node:fs';
import path from 'node:path';

export const GM_VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8770';
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_COMMAND_LENGTH = 512;
export const MAX_SELF_CHALLENGE = 8;

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function error(code, message, field = null) {
  return { code, message, ...(field ? { field } : {}) };
}

function fail(code, message, extra = {}) {
  return { ok: false, error: error(code, message, extra.field ?? null), ...extra };
}

function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

export function validateGMRequest(req, { maxCommandLength = DEFAULT_MAX_COMMAND_LENGTH } = {}) {
  if (!req || typeof req !== 'object') {
    return { ok: false, error: error('invalid_request', 'request object is required') };
  }
  const runId = req.runId;
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return {
      ok: false,
      error: error('invalid_run_id', 'runId is required and must match [A-Za-z0-9][A-Za-z0-9._:-]{0,95}', 'runId'),
    };
  }
  const command = req.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, error: error('invalid_command', 'command is required', 'command') };
  }
  if (command.length > maxCommandLength) {
    return {
      ok: false,
      error: error('invalid_command', `command exceeds ${maxCommandLength} characters`, 'command'),
    };
  }
  const reason = req.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { ok: false, error: error('invalid_reason', 'reason is required', 'reason') };
  }
  if (reason.length > 300) {
    return { ok: false, error: error('invalid_reason', 'reason exceeds 300 characters', 'reason') };
  }
  const selfChallenge = req.selfChallenge;
  if (!Array.isArray(selfChallenge) || selfChallenge.length === 0) {
    return {
      ok: false,
      error: error('invalid_self_challenge', 'selfChallenge must be a non-empty array', 'selfChallenge'),
    };
  }
  if (selfChallenge.length > MAX_SELF_CHALLENGE) {
    return {
      ok: false,
      error: error('invalid_self_challenge', `selfChallenge has more than ${MAX_SELF_CHALLENGE} items`, 'selfChallenge'),
    };
  }
  for (const item of selfChallenge) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > 300) {
      return {
        ok: false,
        error: error('invalid_self_challenge', 'selfChallenge items must be non-empty strings <=300 chars', 'selfChallenge'),
      };
    }
  }
  return {
    ok: true,
    value: {
      runId,
      command,
      reason,
      selfChallenge: [...selfChallenge],
      before: req.before ?? null,
      after: req.after ?? null,
      meta: req.meta ?? null,
    },
  };
}

/** Append one GM entry to gm.jsonl. The caller supplies before/after state. */
export async function appendGmJournal(filePath, entry) {
  if (!filePath) throw new Error('journal path is required');
  const record = {
    ts: new Date().toISOString(),
    schema: 'numen-gm/1',
    source: 'gm-provider',
    assisted: true,
    ...entry,
  };
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function createGMProvider({
  baseUrl = process.env.GM_BASE_URL || DEFAULT_BASE_URL,
  token = process.env.NUMEN_GM_TOKEN || process.env.GM_TOKEN || null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxCommandLength = DEFAULT_MAX_COMMAND_LENGTH,
  allowRemote = false,
  journalPath = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`GM baseUrl is invalid: ${baseUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`GM baseUrl must be http(s): ${baseUrl}`);
  }
  if (!allowRemote && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`GM baseUrl must be loopback (got ${parsed.hostname}); set allowRemote only with Lead approval`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');

  const root = baseUrl.replace(/\/+$/, '');

  async function finish(entry, result) {
    if (!journalPath) return result;
    try {
      await appendGmJournal(journalPath, {
        runId: entry?.runId ?? null,
        reason: entry?.reason ?? null,
        selfChallenge: entry?.selfChallenge ?? [],
        command: entry?.command ?? null,
        before: entry?.before ?? null,
        after: entry?.after ?? null,
        meta: entry?.meta ?? null,
        outcome: result.ok
          ? { ok: true, result: result.result, world: result.world }
          : { ok: false, error: result.error },
      });
    } catch (e) {
      return { ...result, journalError: String(e?.message || e) };
    }
    return result;
  }

  async function command(req) {
    const check = validateGMRequest(req, { maxCommandLength });
    if (!check.ok) return check;
    if (!token) {
      return fail('missing_token', 'GM token is not configured (NUMEN_GM_TOKEN/GM_TOKEN or token option)');
    }
    const entry = check.value;
    const body = JSON.stringify({
      runId: entry.runId,
      command: entry.command,
      reason: entry.reason,
      selfChallenge: entry.selfChallenge,
    });
    let res;
    try {
      res = await fetchImpl(`${root}/dev/v1/command`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return finish(entry, fail(timeout ? 'timeout' : 'network_error',
        timeout ? `GM portal did not answer within ${timeoutMs} ms` : String(e?.message || e)));
    }

    const status = res.status;
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      return finish(entry, fail('network_error', `failed to read GM response: ${e?.message || e}`, { httpStatus: status }));
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      if (!res.ok) {
        return finish(entry, fail(`http_${status}`, text.slice(0, 300) || `HTTP ${status}`, { httpStatus: status }));
      }
      return finish(entry, fail('invalid_response', 'GM portal returned non-JSON success body', { httpStatus: status }));
    }

    if (!res.ok || !data || data.ok !== true) {
      const code = data?.error?.code || `http_${status}`;
      const message = data?.error?.message || `GM portal returned HTTP ${status}`;
      const retryAfter = res.headers?.get?.('retry-after') ?? null;
      return finish(entry, {
        ok: false,
        error: error(code, message, data?.error?.field ?? null),
        httpStatus: status,
        ...(retryAfter ? { retryAfter } : {}),
      });
    }

    return finish(entry, {
      ok: true,
      result: Number(data.result) || 0,
      output: Array.isArray(data.output) ? data.output : [],
      world: data.world ?? null,
      httpStatus: status,
      runId: entry.runId,
    });
  }

  async function health() {
    let res;
    try {
      res = await fetchImpl(`${root}/health`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return fail(timeout ? 'timeout' : 'network_error', String(e?.message || e));
    }
    try {
      const data = JSON.parse(await res.text());
      if (!res.ok) return { ok: false, error: error(`http_${res.status}`, 'health check failed'), httpStatus: res.status };
      return { ok: true, httpStatus: res.status, ...data };
    } catch {
      return { ok: false, error: error('invalid_response', 'health check returned non-JSON'), httpStatus: res.status };
    }
  }

  return {
    kind: 'gm',
    baseUrl: root,
    command,
    health,
    hasToken: Boolean(token),
    journalPath,
  };
}

export function createGMProviderFromEnv(options = {}) {
  return createGMProvider(options);
}
