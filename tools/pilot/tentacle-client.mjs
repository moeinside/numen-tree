#!/usr/bin/env node
/**
 * TentacleClient — Pilot-side, read-only diagnostic client for 127.0.0.1:8769.
 *
 * Scope (docs/84 §5, docs/90 §1B):
 * - GET only. The mod itself rejects non-GET requests.
 * - self / terrain / entities / water / landmarks are projections of the same
 *   `/perception` response; no action or mutation endpoints are ever called.
 * - Diagnostic / candidate evidence only. The tentacle is **not** an action
 *   precondition authority and cannot replace live numen observations.
 * - Every call appends one line to `runs/<runId>/tentacle_use.jsonl` (or the
 *   `journalPath` given by the caller), including structured failures.
 *
 * Structured failures never throw for network/HTTP/mod errors:
 *   { ok:false, error:{code,message,...}, httpStatus? }
 *
 * CLI:
 *   node tools/pilot/tentacle-client.mjs --uuid=<uuid> --run-id=<run> \
 *     --purpose="diagnose water" --fields=self,water
 *   node tools/pilot/tentacle-client.mjs --health
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export const TENTACLE_VERSION = '0.1.0';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8769;
export const DEFAULT_TIMEOUT_MS = 2_500;
export const FIELDS = ['self', 'terrain', 'entities', 'water', 'landmarks'];
export const AUTHORITY = Object.freeze({
  role: 'diagnostic',
  actionPrecondition: false,
  note: 'tentacle is diagnostic/candidate evidence only; not action authority',
});
export const JOURNAL_SCHEMA = 'numen-tentacle-use/1';

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

function errObj(code, message, field = null) {
  return { code, message, ...(field ? { field } : {}) };
}

function fail(code, message, extra = {}) {
  return { ok: false, error: errObj(code, message, extra.field ?? null), ...extra };
}

function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Append one diagnostic-use record. Caller must pass a non-secret record. */
export async function appendTentacleUse(filePath, entry) {
  if (!filePath) throw new Error('journal path is required');
  const record = {
    ts: new Date().toISOString(),
    schema: JOURNAL_SCHEMA,
    source: 'tentacle-client',
    authority: 'diagnostic-only',
    actionPrecondition: false,
    assisted: false,
    ...entry,
  };
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function resolveRunDir(runId, { runDir = null } = {}) {
  if (runDir) return path.resolve(runDir);
  if (!runId || !RUN_ID_RE.test(String(runId))) return null;
  return path.join(ROOT, 'runs', String(runId));
}

/** Compact a raw `/perception` body for journals/CLI (never the whole map). */
export function summarizePerception(raw, fields = FIELDS) {
  const out = { ok: true, source: 'tentacle' };
  const wanted = new Set(fields);
  if (wanted.has('self')) {
    const s = raw?.self || {};
    out.self = {
      name: s.name ?? null,
      uuid: s.uuid ?? null,
      hp: s.hp ?? null,
      max_hp: s.max_hp ?? null,
      food: s.food ?? null,
      pos: { x: s.x ?? null, y: s.y ?? null, z: s.z ?? null },
      yaw: s.yaw ?? null,
      pitch: s.pitch ?? null,
      dimension: s.dimension ?? null,
      light: s.light ?? null,
      day: s.day ?? null,
      day_time: s.day_time ?? null,
    };
  }
  if (wanted.has('terrain')) {
    const t = raw?.terrain || {};
    out.terrain = {
      in_water: t.in_water ?? null,
      in_lava: t.in_lava ?? null,
      on_ground: t.on_ground ?? null,
      feet: t.feet ?? null,
      head: t.head ?? null,
      above: t.above ?? null,
      below: t.below ?? null,
      standable_dirs: Array.isArray(t.dirs)
        ? t.dirs.filter((d) => d?.standable).map((d) => ({ dx: d.dx, dz: d.dz, feet: d.feet }))
        : [],
    };
  }
  if (wanted.has('entities')) {
    const list = Array.isArray(raw?.entities) ? raw.entities : [];
    const by = (category) => list.filter((e) => e?.category === category);
    const nearest = (arr) =>
      arr
        .slice()
        .sort((a, b) => Number(a.distance) - Number(b.distance))[0] || null;
    out.entities = {
      count: list.length,
      hostiles: by('hostile').length,
      animals: by('animal').length,
      players: by('player').length,
      other: by('other').length,
      nearest: nearest(list),
      sample: list.slice(0, 5).map((e) => ({
        type: e.type,
        category: e.category,
        distance: e.distance,
        hp: e.hp,
        x: e.x,
        y: e.y,
        z: e.z,
      })),
    };
  }
  if (wanted.has('water')) out.water = raw?.water ?? null;
  if (wanted.has('landmarks')) {
    const list = Array.isArray(raw?.landmarks) ? raw.landmarks : [];
    out.landmarks = {
      count: list.length,
      counts: list.reduce((acc, l) => {
        if (l?.kind) acc[l.kind] = (acc[l.kind] || 0) + 1;
        return acc;
      }, {}),
      nearest: list.slice(0, 5),
    };
  }
  if (raw?.limits) out.limits = raw.limits;
  out.caveats = [
    'landmarks/water may include blocks outside FOV/LOS; not all-knowing',
    'diagnostic only; prefer live numen self/events for driving decisions',
  ];
  return out;
}

export function createTentacleClient({
  host = process.env.TENTACLE_HOST || DEFAULT_HOST,
  port = process.env.TENTACLE_PORT || DEFAULT_PORT,
  timeoutMs = process.env.TENTACLE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
  runId = process.env.TENTACLE_RUN_ID || process.env.PILOT_RUN_ID || null,
  purpose = null,
  journalPath = undefined,
  runDir = null,
  allowRemote = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanHost = String(host || DEFAULT_HOST).trim();
  if (!allowRemote && !isLoopbackHost(cleanHost)) {
    throw new Error(`tentacle host must be loopback (got ${cleanHost}); set allowRemote only for mock tests`);
  }
  const cleanPort = Number(port);
  if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
    throw new Error(`tentacle port is invalid: ${port}`);
  }
  const cleanTimeout = Number(timeoutMs);
  if (!Number.isFinite(cleanTimeout) || cleanTimeout <= 0) {
    throw new Error(`tentacle timeoutMs must be positive: ${timeoutMs}`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const root = `http://${cleanHost.includes(':') && !cleanHost.startsWith('[') ? `[${cleanHost}]` : cleanHost}:${cleanPort}`;
  const effectiveRunId = runId || generatedRunId();
  const journal =
    journalPath === null
      ? null
      : journalPath ||
        path.join(resolveRunDir(effectiveRunId, { runDir }), 'tentacle_use.jsonl');

  async function finish(meta, result) {
    if (!journal) return result;
    try {
      await appendTentacleUse(journal, {
        runId: meta.runId ?? effectiveRunId,
        purpose: meta.purpose ?? purpose ?? 'diagnostic',
        fields: meta.fields ?? null,
        query: meta.query ?? null,
        ok: result.ok === true,
        summary: result.ok ? result.summary : null,
        error: result.ok ? null : result.error,
        httpStatus: result.httpStatus ?? null,
      });
    } catch (e) {
      return { ...result, journalError: String(e?.message || e) };
    }
    return result;
  }

  async function getJson(pathname, meta) {
    let res;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(cleanTimeout)
          : undefined;
      res = await fetchImpl(`${root}${pathname}`, { method: 'GET', signal });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      return finish(
        meta,
        fail(
          timeout ? 'timeout' : 'network_error',
          timeout
            ? `tentacle did not answer within ${cleanTimeout} ms`
            : `cannot reach tentacle ${root} (mod absent / game not restarted / port not listening)`,
          { detail: String(e?.message || e) },
        ),
      );
    }

    const status = res.status;
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      return finish(
        meta,
        fail('network_error', `failed to read tentacle response: ${e?.message || e}`, { httpStatus: status }),
      );
    }

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return finish(
        meta,
        fail('invalid_response', 'tentacle returned non-JSON body', {
          httpStatus: status,
          bodyPreview: String(text).slice(0, 200),
        }),
      );
    }
    if (!res.ok) {
      return finish(
        meta,
        fail(`http_${status}`, `tentacle returned HTTP ${status}`, {
          httpStatus: status,
          detail: data,
        }),
      );
    }
    if (!data || data.ok !== true) {
      const detail = typeof data?.error === 'string' ? data.error : data?.error ?? 'unknown';
      const code =
        detail === 'need uuid'
          ? 'missing_uuid'
          : detail === 'server not ready'
            ? 'server_not_ready'
            : detail === 'entity not found'
              ? 'entity_not_found'
              : 'tentacle_error';
      return finish(
        meta,
        fail(code, `tentacle rejected request: ${String(detail).slice(0, 200)}`, {
          httpStatus: status,
          tentacleError: detail,
        }),
      );
    }
    return { ok: true, data, httpStatus: status };
  }

  function normalizeQuery({ uuid, radius = 16, limit = 20, fov = 100, fields = FIELDS } = {}) {
    if (typeof uuid !== 'string' || uuid.trim() === '') {
      return fail('missing_uuid', 'perception requires the companion uuid (--uuid or TENTACLE_UUID)');
    }
    if (!UUID_RE.test(uuid.trim())) {
      return fail('invalid_uuid', 'uuid must be a 32-36 char UUID (hyphens optional)', { field: 'uuid' });
    }
    const selected = Array.isArray(fields) ? fields : String(fields).split(',');
    const cleanFields = [...new Set(selected.map((f) => String(f).trim()).filter(Boolean))];
    if (cleanFields.length === 0) {
      return fail('invalid_fields', `fields must be a non-empty subset of ${FIELDS.join(',')}`, { field: 'fields' });
    }
    const unknown = cleanFields.filter((f) => !FIELDS.includes(f));
    if (unknown.length) {
      return fail('invalid_fields', `unknown tentacle field(s): ${unknown.join(',')}`, { field: 'fields' });
    }
    if (radius != null && !Number.isFinite(Number(radius))) {
      return fail('invalid_param', 'radius must be numeric', { field: 'radius' });
    }
    if (limit != null && !Number.isFinite(Number(limit))) {
      return fail('invalid_param', 'limit must be numeric', { field: 'limit' });
    }
    if (fov != null && !Number.isFinite(Number(fov))) {
      return fail('invalid_param', 'fov must be numeric', { field: 'fov' });
    }
    return {
      ok: true,
      value: {
        uuid: uuid.trim(),
        radius: clampNum(radius, 4, 48, 16),
        limit: clampInt(limit, 1, 30, 20),
        fov: clampNum(fov, 30, 180, 100),
        fields: cleanFields,
      },
    };
  }

  /** Full `/perception` call. Returns {ok,summary,raw,...} or structured failure. */
  async function perception(opts = {}) {
    const meta = {
      runId: opts.runId ?? effectiveRunId,
      purpose: opts.purpose ?? purpose ?? null,
      fields: opts.fields ?? FIELDS,
      query: null,
    };
    const q = normalizeQuery(opts);
    if (!q.ok) return finish(meta, q);
    const { uuid, radius, limit, fov, fields } = q.value;
    const params = new URLSearchParams({
      uuid,
      radius: String(radius),
      limit: String(limit),
      fov: String(fov),
    });
    meta.query = { uuid, radius, limit, fov, fields };
    const got = await getJson(`/perception?${params.toString()}`, meta);
    if (!got.ok) return got;
    const summary = summarizePerception(got.data, fields);
    return finish(meta, {
      ok: true,
      authority: AUTHORITY,
      httpStatus: got.httpStatus,
      summary,
      raw: got.data,
    });
  }

  /** Query one projection of perception: self / terrain / entities / water / landmarks. */
  async function query(field, opts = {}) {
    const fields = [field];
    const meta = {
      runId: opts.runId ?? effectiveRunId,
      purpose: opts.purpose ?? purpose ?? null,
      fields,
      query: null,
    };
    if (!FIELDS.includes(field)) {
      return finish(meta, fail('invalid_fields', `unknown tentacle field: ${field}`, { field: 'fields' }));
    }
    const r = await perception({ ...opts, fields });
    if (!r.ok) return r;
    return {
      ok: true,
      authority: AUTHORITY,
      httpStatus: r.httpStatus,
      field,
      summary: r.summary,
      raw: r.raw,
    };
  }

  async function health() {
    const meta = { runId: effectiveRunId, purpose: purpose ?? 'health', fields: ['health'], query: null };
    const got = await getJson('/health', meta);
    if (!got.ok) return got;
    const health = {
      mod: got.data.mod ?? null,
      version: got.data.version ?? null,
      port: got.data.port ?? null,
      server: got.data.server ?? null,
    };
    return finish(meta, {
      ok: true,
      httpStatus: got.httpStatus,
      ...health,
      summary: { health },
      authority: AUTHORITY,
    });
  }

  return {
    kind: 'tentacle',
    version: TENTACLE_VERSION,
    baseUrl: root,
    runId: effectiveRunId,
    journalPath: journal,
    authority: AUTHORITY,
    health,
    perception,
    query,
    self: (opts) => query('self', opts),
    terrain: (opts) => query('terrain', opts),
    entities: (opts) => query('entities', opts),
    water: (opts) => query('water', opts),
    landmarks: (opts) => query('landmarks', opts),
  };
}

export function createTentacleClientFromEnv(options = {}) {
  return createTentacleClient(options);
}

// ── CLI ───────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const value = eq >= 0 ? raw.slice(eq + 1) : true;
    out[key] = value;
  }
  return out;
}

function generatedRunId() {
  return `tentacle-diag-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function printResult(result) {
  if (result.ok && result.summary) {
    console.log(JSON.stringify({ ok: true, authority: 'diagnostic-only', summary: result.summary }, null, 2));
    return;
  }
  console.log(JSON.stringify({ ok: false, authority: 'diagnostic-only', ...result }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args['run-id'] || process.env.TENTACLE_RUN_ID || process.env.PILOT_RUN_ID || generatedRunId();
  const runDir = args['run-dir'] || null;
  const host = args.host || process.env.TENTACLE_HOST || DEFAULT_HOST;
  const port = args.port ? Number(args.port) : Number(process.env.TENTACLE_PORT || DEFAULT_PORT);
  const timeoutMs = args['timeout-ms']
    ? Number(args['timeout-ms'])
    : Number(process.env.TENTACLE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const purpose = args.purpose || 'tentacle diagnostic';
  const fields = args.fields ? String(args.fields).split(',') : FIELDS;
  const noJournal = args['no-journal'] === true || args['no-journal'] === 'true';

  const client = createTentacleClient({
    host,
    port,
    timeoutMs,
    runId,
    purpose,
    runDir,
    journalPath: noJournal ? null : undefined,
  });

  let result;
  if (args.health) {
    result = await client.health();
  } else {
    result = await client.perception({
      uuid: args.uuid || process.env.TENTACLE_UUID,
      radius: args.radius,
      limit: args.limit,
      fov: args.fov,
      fields,
      purpose,
      runId,
    });
  }

  printResult(result);
  if (client.journalPath) console.error(`journal: ${client.journalPath}`);
  if (!result.ok) process.exitCode = 1;
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: { code: 'fatal', message: String(e?.message || e) } }));
    process.exitCode = 1;
  });
}
