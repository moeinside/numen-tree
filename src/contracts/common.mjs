/** Shared validators for S0 contracts. Keep dependency-free. */

export function isObj(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function oneOf(value, allowed) {
  return allowed.includes(value);
}

export function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function requireFields(errors, obj, fields) {
  for (const f of fields) {
    if (obj?.[f] === undefined || obj[f] === null) errors.push(`missing:${f}`);
  }
}

export function result(errors) {
  return { ok: errors.length === 0, errors };
}
