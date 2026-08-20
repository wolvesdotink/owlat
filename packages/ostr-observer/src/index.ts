/**
 * @owlat/ostr-observer — the observer half of the Open Sender Trust Registry
 * (TRUST_REGISTRY_PLAN §7, §12.1).
 *
 * What an observer does, in the order it does it:
 *
 * 1. {@link assertObserverEligible} — observer mode is off by default and
 *    hard-disabled below the mailbox threshold. Nothing below runs until this
 *    says yes (§7.4).
 * 2. {@link shouldCaptureReport} — the same (Message-ID, `bh=`) reported twice
 *    is one message; DKIM signatures are replayable (§7.3).
 * 3. {@link buildEvidenceBundle} — the DKIM proof that the accused really sent
 *    it, gated on `@owlat/ostr-core`'s admissibility rules. THE BUNDLE NEVER
 *    LEAVES THE OBSERVER; only its hash is committed (§7.1, §7.2).
 * 4. {@link TrafficAccumulator} — per-subject windowed counts, with the
 *    k-anonymity floor and automatic window widening (§7.4).
 * 5. {@link buildReportedWindow} — a spam-report batch is publishable only
 *    alongside its own traffic-summary, which is its denominator (§7.3), and
 *    only above BOTH halves of the k-floor: enough reports and enough distinct
 *    reporters (§7.4).
 * 6. {@link buildTrapHitBatch} — the same shape for never-subscribed trap
 *    addresses: a count, its denominator, and a k-floor (§5, §6.3).
 * 7. {@link KeyObservationTracker} — the logged key record that makes a
 *    challenge adjudicable after the key has left DNS (§7.5).
 * 8. {@link signDrafts} + {@link submitAll} — signed with the observer's key,
 *    cross-submitted to at least two logs (§5, §9.1).
 * 9. {@link retainBatchCommitment} + {@link answerChallenge} — the published
 *    batch's ordered bundle list, kept so a monitor's sampled indices can
 *    actually be opened (§7.2.4). An unanswerable batch is a discarded batch
 *    plus an observer standing penalty.
 *
 * Everything here is pure and injected: no clock, no DNS, no `fetch`, no
 * storage. Timestamps, dedupe/key/commitment stores, and the JSON poster are
 * the app's to provide — including the retention cutoffs the prunes take
 * (`MemoryReportDedupeStore.prune`, `TrafficAccumulator.dropHeldBefore`,
 * `MemoryBatchCommitmentStore.prune`), which are the same ~90-day §7.2 cutoff
 * that deletes the evidence bundles.
 */

export {
	assertObserverEligible,
	OBSERVER_MIN_MAILBOXES,
	type ObserverEligibility,
	type ObserverEligibilityInput,
	type ObserverIneligibilityReason,
} from './eligibility.js';

export {
	buildEvidenceBundle,
	hashEvidenceBundle,
	type DkimVerificationVerdict,
	type EvidenceBundle,
	type EvidenceBundleResult,
	type EvidenceCaptureReason,
	type EvidenceInput,
	type EvidenceRejectionReason,
	type RawSignedHeader,
} from './evidence.js';

export {
	MemoryReportDedupeStore,
	reportDedupeKey,
	shouldCaptureReport,
	type ReportCaptureDecision,
	type ReportDedupeStore,
	type ReportIdentity,
} from './dedupe.js';

export {
	bounceRateBucket,
	logScaleBucket,
	MAX_BOUNCE_RATE_BUCKET,
	MAX_UNIQUE_RECIPIENTS_BUCKET,
} from './buckets.js';

export {
	DEFAULT_K_THRESHOLDS,
	resolveKThresholds,
	type KThresholdOverrides,
	type KThresholds,
} from './thresholds.js';

export {
	DEFAULT_MAX_HELD_SUBJECTS,
	TrafficAccumulator,
	type EmitTrafficInput,
	type HeldSubject,
	type MessageObservation,
	type SubjectTotalsState,
	type TrafficAccumulatorOptions,
	type TrafficAccumulatorState,
	type TrafficEmission,
} from './traffic.js';

export {
	buildReportedWindow,
	buildSpamReportBatch,
	type ReportedWindowInput,
	type ReportedWindowResult,
	type SpamBatchHold,
	type SpamBatchRefusal,
	type SpamReportBatchInput,
	type SpamReportBatchResult,
	type SpamReportEntry,
} from './spamBatch.js';

export {
	buildTrapHitBatch,
	type TrapHitBatchInput,
	type TrapHitBatchResult,
	type TrapHitRefusal,
} from './trapHit.js';

export {
	answerChallenge,
	MemoryBatchCommitmentStore,
	retainBatchCommitment,
	type BatchCommitmentRecord,
	type BatchCommitmentStore,
	type ChallengeAnswer,
	type ChallengeOpening,
	type ChallengeRefusal,
} from './challenge.js';

export {
	KeyObservationTracker,
	MemoryKeyObservationStore,
	type KeyObservationDisposition,
	type KeyObservationInput,
	type KeyObservationRecord,
	type KeyObservationRefusal,
	type KeyObservationResult,
	type KeyObservationStore,
} from './keyObservations.js';

export { draftToUnsigned, signDrafts } from './sign.js';

export {
	MIN_CROSS_SUBMIT_LOGS,
	submitAll,
	type AttestationSubmission,
	type LogOutcome,
	type PostJson,
	type SubmitAllInput,
	type SubmitAllResult,
} from './submit.js';

export {
	normalizeDomain,
	normalizeIp,
	sameSubject,
	sameWindow,
	subjectKey,
	type AttestationDraft,
	type ObserverIdentity,
} from './types.js';
