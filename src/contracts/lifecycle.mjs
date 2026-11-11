export const COMMITMENT_TRANSITIONS = {
  proposed: ['active', 'abandoned'],
  active: ['blocked', 'done', 'failed', 'abandoned', 'expired'],
  blocked: ['active', 'failed', 'abandoned', 'expired'],
  done: [],
  failed: [],
  abandoned: [],
  expired: [],
};

export function canTransition(from, to) {
  return (COMMITMENT_TRANSITIONS[from] || []).includes(to);
}

/** Done requires a matching result event with postcheck success. */
export function canComplete(commitment, event) {
  return Boolean(
    commitment &&
    event &&
    event.commitmentId === commitment.id &&
    event.status === 'ok' &&
    event.postcheck &&
    typeof event.postcheck === 'object',
  );
}

/** Only the B ledger writer may mutate commitment state. */
export function assertWriter(writer) {
  return writer === 'ledger';
}
