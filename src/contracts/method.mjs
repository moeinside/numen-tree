import { isObj, nonEmptyString, finiteNumber, oneOf, isStringArray, requireFields, result } from './common.mjs';

export const METHOD_TIERS = ['life', 'irreversible', 'reversible', 'opportunity', 'maintenance'];
export const METHOD_DOMAINS = [
  'survival', 'resource', 'build', 'combat', 'explore',
  'food', 'farm', 'trade', 'player_task', 'other',
];

/**
 * A method is data, not a scheduler. `preconditions` is the blocking field from
 * the MC review: allowedMethods must not pass a method whose preconditions are
 * unknown/false.
 */
export function validateMethod(m) {
  const errors = [];
  if (!isObj(m)) return result(['method:not_object']);
  requireFields(errors, m, [
    'id', 'version', 'domain', 'tier', 'preconditions', 'requiredToolTier',
    'needsLoadedChunk', 'expectedProgress',
    'cost', 'estimatedTimeMs', 'risk', 'reversibility', 'successPredicate',
    'fallback', 'evidenceRef',
  ]);
  if (!('stationRef' in m)) errors.push('missing:stationRef');
  if (!('requiredDimension' in m)) errors.push('missing:requiredDimension');
  if (!nonEmptyString(m.id)) errors.push('id');
  if (!finiteNumber(m.version) || m.version < 1) errors.push('version');
  if (!oneOf(m.domain, METHOD_DOMAINS)) errors.push('domain');
  if (!oneOf(m.tier, METHOD_TIERS)) errors.push('tier');
  if (!isStringArray(m.preconditions)) errors.push('preconditions');
  if (m.requiredToolTier !== null && typeof m.requiredToolTier !== 'string') errors.push('requiredToolTier');
  if (m.stationRef !== null && typeof m.stationRef !== 'string' && !isObj(m.stationRef)) errors.push('stationRef');
  if (m.requiredDimension !== null && typeof m.requiredDimension !== 'string') errors.push('requiredDimension');
  if (typeof m.needsLoadedChunk !== 'boolean') errors.push('needsLoadedChunk');
  if (!finiteNumber(m.expectedProgress) || m.expectedProgress < 0) errors.push('expectedProgress');
  if (!finiteNumber(m.cost) || m.cost < 0) errors.push('cost');
  if (!finiteNumber(m.estimatedTimeMs) || m.estimatedTimeMs <= 0) errors.push('estimatedTimeMs');
  if (!finiteNumber(m.risk) || m.risk < 0 || m.risk > 1) errors.push('risk');
  if (!finiteNumber(m.reversibility) || m.reversibility < 0 || m.reversibility > 1) errors.push('reversibility');
  if (!nonEmptyString(m.successPredicate)) errors.push('successPredicate');
  if (!nonEmptyString(m.fallback)) errors.push('fallback');
  if (!nonEmptyString(m.evidenceRef)) errors.push('evidenceRef');
  return result(errors);
}

export function innerScore(m) {
  const timeSec = Math.max(1, m.estimatedTimeMs / 1000);
  return (m.expectedProgress / timeSec) - (m.risk * 0.5) - ((1 - m.reversibility) * 0.25);
}
