import { isObj, nonEmptyString, finiteNumber, oneOf, requireFields, result } from './common.mjs';

export const RESULT_STATUSES = ['ok', 'failed', 'preempted', 'refused', 'timeout', 'slot_blocked', 'cancelled'];
export const FAILURE_CLASSES = ['capability', 'material_unavailable', 'unknown', 'refused'];
export const REFUSED_REASONS = ['consent', 'owner_placed', 'base_no_dig'];
export const EVENT_SOURCES = ['numen', 'tentacle', 'groundtruth'];

/** 15 required fields: freeze this list; everything else optional. */
export const EVENT_REQUIRED = [
  'eventSeq', 'txId', 'atomId', 'commitmentId', 'gameTick', 'methodId',
  'status', 'kind', 'durationMs', 'paramsHash', 'snapshotSeqBefore',
  'snapshotSeqAfter', 'postcheck', 'evidenceSeq', 'source',
];

export function validateResultEvent(e) {
  const errors = [];
  if (!isObj(e)) return result(['event:not_object']);
  requireFields(errors, e, EVENT_REQUIRED);
  for (const k of ['eventSeq', 'gameTick', 'durationMs', 'snapshotSeqBefore', 'snapshotSeqAfter', 'evidenceSeq']) {
    if (!finiteNumber(e[k]) || e[k] < 0) errors.push(k);
  }
  for (const k of ['txId', 'atomId', 'commitmentId', 'methodId', 'kind', 'paramsHash']) {
    if (!nonEmptyString(e[k])) errors.push(k);
  }
  if (!oneOf(e.status, RESULT_STATUSES)) errors.push('status');
  if (!oneOf(e.source, EVENT_SOURCES)) errors.push('source');
  if (!isObj(e.postcheck)) errors.push('postcheck');
  if (e.failureClass != null && !oneOf(e.failureClass, FAILURE_CLASSES)) errors.push('failureClass');
  if (e.refusedReason != null && !oneOf(e.refusedReason, REFUSED_REASONS)) errors.push('refusedReason');
  if (e.postcheck && !isObj(e.postcheck)) errors.push('postcheck');
  return result(errors);
}

/** Production death events cannot claim cause/killer/inventory. */
export function validateDeathEvent(e) {
  const errors = [];
  if (!isObj(e)) return result(['death:not_object']);
  requireFields(errors, e, ['eventSeq', 'gameTick', 'pos', 'dimension', 'lastCommitmentId', 'source']);
  if (!finiteNumber(e.eventSeq) || e.eventSeq < 0) errors.push('eventSeq');
  if (!finiteNumber(e.gameTick) || e.gameTick < 0) errors.push('gameTick');
  if (!isObj(e.pos)) errors.push('pos');
  if (!nonEmptyString(e.dimension)) errors.push('dimension');
  if (!oneOf(e.source, EVENT_SOURCES)) errors.push('source');
  const hasFixtureFields = e.cause != null || e.killer != null || e.inventorySummary != null;
  if (hasFixtureFields && e.source !== 'groundtruth') {
    errors.push('fixture_fields_require_groundtruth');
  }
  return result(errors);
}
