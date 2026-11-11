import { isObj, nonEmptyString, finiteNumber, oneOf, requireFields, result } from './common.mjs';

export const COMMITMENT_KINDS = ['survival', 'long_term'];
export const COMMITMENT_SOURCES = ['auto', 'player', 'llm'];
export const CONSENT_STATES = ['none', 'pending', 'granted', 'denied', 'expired', 'policy_pre_authorized'];
export const CONSENT_SCOPES = ['per_action', 'per_region', 'per_session'];
export const CONSENT_DENIED_REASONS = ['owner_absent', 'owner_placed_block', 'region', 'owner_offline'];
export const DEADLINE_WINDOW_TYPES = ['day', 'dusk', 'night', 'absolute'];
export const COMMITMENT_STATUSES = ['proposed', 'active', 'blocked', 'done', 'failed', 'abandoned', 'expired'];
export const PREDICATE_SOURCES = ['L0', 'L1'];

/**
 * MC correction: auto is not "granted"; it is a policy pre-authorization that
 * numen can still refuse per action. Owner-built/placed regions need pending.
 */
export function defaultConsent(source, { ownerRegion = false } = {}) {
  if (source === 'auto') return ownerRegion ? 'pending' : 'policy_pre_authorized';
  if (source === 'player' || source === 'llm') return 'pending';
  return 'none';
}

export function validateCommitment(c) {
  const errors = [];
  if (!isObj(c)) return result(['commitment:not_object']);
  requireFields(errors, c, [
    'id', 'kind', 'source', 'requiresConsent', 'consentState', 'predicate',
    'predicateSource', 'deadlineWindow', 'status', 'evidenceRef', 'basis',
    'ttl', 'retryBudget', 'createdAt', 'updatedAt',
  ]);
  if (!nonEmptyString(c.id)) errors.push('id');
  if (!oneOf(c.kind, COMMITMENT_KINDS)) errors.push('kind');
  if (!oneOf(c.source, COMMITMENT_SOURCES)) errors.push('source');
  if (typeof c.requiresConsent !== 'boolean') errors.push('requiresConsent');
  if (!oneOf(c.consentState, CONSENT_STATES)) errors.push('consentState');
  if (c.consentScope != null && !oneOf(c.consentScope, CONSENT_SCOPES)) errors.push('consentScope');
  if (c.consentDeniedReason != null && !oneOf(c.consentDeniedReason, CONSENT_DENIED_REASONS)) {
    errors.push('consentDeniedReason');
  }
  if (!oneOf(c.status, COMMITMENT_STATUSES)) errors.push('status');
  if (!oneOf(c.predicateSource, PREDICATE_SOURCES)) errors.push('predicateSource');
  if (!nonEmptyString(c.predicate)) errors.push('predicate');
  if (!nonEmptyString(c.evidenceRef)) errors.push('evidenceRef');
  if (!finiteNumber(c.ttl) || c.ttl < 0) errors.push('ttl');
  if (!finiteNumber(c.retryBudget) || c.retryBudget < 0) errors.push('retryBudget');
  if (!isObj(c.basis) || !finiteNumber(c.basis.snapshotSeq) || !finiteNumber(c.basis.gameTick)) {
    errors.push('basis');
  }
  if (!isObj(c.deadlineWindow) || !oneOf(c.deadlineWindow.windowType, DEADLINE_WINDOW_TYPES)) {
    errors.push('deadlineWindow.windowType');
  }
  if (c.deadlineWindow && !finiteNumber(c.deadlineWindow.remainingSec)) {
    errors.push('deadlineWindow.remainingSec');
  }
  if (c.requiresConsent && !c.consentScope) errors.push('consentScope');
  if (c.requiresConsent && !finiteNumber(c.consentCheckedAt) && c.consentState !== 'pending') {
    errors.push('consentCheckedAt');
  }
  return result(errors);
}

export function applyConsentRefusal(c, reason = 'owner_absent') {
  return { ...c, consentState: 'denied', consentDeniedReason: reason, updatedAt: Date.now() };
}
