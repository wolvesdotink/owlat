/**
 * Scoring module: the versioned, pure, deterministic policy
 * `ostr-policy-v1`: (sequenced log entries, subject) → (tier, score,
 * explanation). Golden-file determinism tests pin byte-identical output.
 * See TRUST_REGISTRY_PLAN §6.
 */

export { POLICY_VERSION, POLICY_V1, type PolicyV1, type TierBoundaries } from './policy.js';
export { scoreSubject, type ScoreSubjectInput } from './score.js';
export { defaultObserverGroup, registrableDomain, type ObserverGrouper } from './select.js';
