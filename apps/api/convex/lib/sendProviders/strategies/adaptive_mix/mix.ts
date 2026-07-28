/**
 * The mix decision — PURE (plan D15).
 *
 * Given a cell's share and one recipient's identity, decide which arm the
 * recipient belongs to and whether it belongs to the randomized calibration
 * slice. No clock, no database, no environment, no `Math.random()`: the
 * decision is a total function of its inputs, and a recipient with no stable
 * identity at all fails CLOSED to the reference arm rather than reaching for a
 * draw — so every branch is reproducible from a fixture.
 *
 * THE ANTI-COHORT PROPERTY (D7) is the reason this file exists. Salting the
 * hash with `contactId` alone would put a contact in the same arm for every
 * campaign forever: the two arms would then be two fixed COHORTS, and every
 * ratio the controller reads would be a comparison of cohort quality rather
 * than of transport quality. The `campaignId` salt is what makes the arms
 * comparable — and a stream with no campaign at all (`automation`,
 * `transactional`) salts with the SEND id instead, so its contacts are re-drawn
 * per message rather than pinned. The `mixVersion` salt re-randomizes the whole
 * population every time the controller moves the share, so a share change is a
 * fresh draw and not a re-labelling of the previous one.
 *
 * THE STRATIFICATION / CALIBRATION SPLIT (D8) is the second reason. Stratified
 * assignment — send the own MTA the most engaged recipients first — is the
 * right WARMING policy and a terrible MEASUREMENT policy: it makes the own arm
 * systematically higher-quality than the reference arm, so any engagement ratio
 * between them is biased by construction. The resolution is not to pick one:
 * stratification stays the default, and a small slice of each cell is carved
 * out and assigned PURELY AT RANDOM. That slice is the only input the
 * engagement-ratio gate is ever allowed to read.
 *
 * The slice is drawn from its OWN hash namespace, never from the arm bucket and
 * never from the engagement rank. That independence is the whole point: if
 * slice membership correlated with engagement rank, every ratio the controller
 * ever reads would be biased and no later test would catch it.
 */

import {
	clampOwnShare,
	OWN_SHARE_CEILING,
	OWN_SHARE_FLOOR,
} from '@owlat/shared/deliverabilityRouting';
import { bucketFor, MIX_BUCKET_SPACE } from './hash';

const MIX_ARMS = ['own', 'reference'] as const;
export type MixArm = (typeof MIX_ARMS)[number];

/** Share below which the calibration slice is the wider 10%. */
const CALIBRATION_WIDE_SLICE_MAX_SHARE = 0.5;
/** Slice size while the cell is still mostly on the reference arm. */
export const CALIBRATION_SLICE_BELOW_HALF = 0.1;
/** Slice size once the own arm carries at least half the cell. */
export const CALIBRATION_SLICE_AT_OR_ABOVE_HALF = 0.05;

/**
 * Mix version 0 = "no controller-driven mix in effect" — the same sentinel
 * `delivery/sendAssignments.ts` records for a router-only assignment.
 */
export const DEFAULT_MIX_VERSION = 0;

/**
 * How the arm was chosen. Recorded for the audit trail (D12): a controller
 * decision nobody can explain is experienced as a bug, and the same is true of
 * an assignment.
 */
export type MixAssignmentBasis =
	/** `s = 0` — the whole cell is on the reference arm (today's behaviour). */
	| 'degenerate_reference'
	/** `s = 1` — the whole cell is on the own arm. */
	| 'degenerate_own'
	/** Randomized calibration slice: the unbiased sample the gate reads. */
	| 'calibration'
	/** Stratified: the top-`s` engagement fraction of the cell. */
	| 'stratified'
	/** Deterministic hash bucket (stratification off, or no engagement rank). */
	| 'random'
	/** No stable identity and no random draw — fails closed to the relay. */
	| 'unidentified';

/**
 * The cell's controller state. `ownShare` is the resolved D1 expression
 * (`ownShare ?? (isFallbackActive ? 0 : 1)`) — this module never reads a route
 * state row itself.
 */
export interface MixCellState {
	readonly ownShare: number;
	readonly mixVersion?: number | undefined;
}

export interface MixRecipientIdentity {
	/** The stable per-recipient salt. Absent for a send with no contact row. */
	readonly contactId?: string | undefined;
	/** THE anti-cohort salt (D7). */
	readonly campaignId?: string | undefined;
	/**
	 * Engagement percentile in `[0,1)`, 1 = most engaged, as produced by
	 * `delivery/sendAssignmentRouting.ts buildEngagementRanker` on top of the
	 * shipped `engagementPercentile`. Absent means "unknown", which falls back
	 * to the random bucket — never to the own arm.
	 *
	 * The producer is responsible for TIE DISPERSION: `engagementPercentile`
	 * hands every member of a tied group the group's UPPER percentile, so a
	 * cohort that is entirely tied (a cold or freshly-imported list — the common
	 * warming case) would rank everybody at 1.0 and the cut below would send the
	 * WHOLE cell to the own arm for any `s > 0`, in the worst possible
	 * direction. The ranker therefore spreads a tied group uniformly across the
	 * percentile interval the group occupies, using each recipient's own stable
	 * hash. This module states the contract; `buildEngagementRanker` holds it.
	 */
	readonly engagementRank?: number | undefined;
	/**
	 * Identity of last resort when there is no contact row: the send id. Every
	 * message has one, it is stable for the life of the send, and it is
	 * independent of anything a recipient could correlate with. A transactional
	 * send therefore still gets a deterministic, unbiased arm.
	 */
	readonly fallbackKey?: string | undefined;
}

export interface MixAssignmentInput {
	readonly cell: MixCellState;
	readonly recipient: MixRecipientIdentity;
}

export interface MixAssignment {
	readonly arm: MixArm;
	readonly isCalibration: boolean;
	/** The resolved, clamped share this decision was taken against. */
	readonly ownShare: number;
	readonly mixVersion: number;
	/**
	 * The recipient's slot in `[0, MIX_BUCKET_SPACE)`, or `null` on the three
	 * branches that decide the arm WITHOUT taking a hash: both degenerate
	 * shares and the unidentifiable recipient. `null` is "never hashed", which
	 * a hard-coded `0` could not be told apart from "hashed to slot 0" — a
	 * distinction any future reader (or persister) of this field needs.
	 */
	readonly bucket: number | null;
	/**
	 * Why this decision came out the way it did. DIAGNOSTIC ONLY: it is not
	 * persisted on the assignment row, because the audit trail D12 asks for is
	 * owned by P3's `mixDecisions` table, which records the CONTROLLER's
	 * per-cell evaluation (from/to share, verdict, failed gate, gate inputs) —
	 * the decision a human can act on. A per-recipient copy of a branch label
	 * would be a second, far larger audit trail of a decision nobody reviews
	 * one recipient at a time. Read it in tests and at a debugger; do not add a
	 * production reader without moving the field to the row first.
	 */
	readonly basis: MixAssignmentBasis;
	/** The rank actually used, when the decision was stratified. */
	readonly engagementRank?: number | undefined;
}

/**
 * What the strategy splits against — the two ways a caller can know a
 * recipient's arm, and the reason the recorded arm and the dispatched transport
 * cannot disagree:
 *
 *   - `decide`: the caller holds the recipient's identity and the cell's share,
 *     so the arm is DERIVED here. This is the enqueue path, where the decision
 *     is taken and recorded.
 *   - `assigned`: the caller holds an arm that was already decided and recorded
 *     (`sendAssignments`). This is the DISPATCH path. It replays the recorded
 *     decision rather than re-deriving it, because one input of the enqueue
 *     decision — the recipient's engagement percentile within that batch's
 *     cohort — is a property of the batch and is not reconstructible from one
 *     message. Replaying the record is what makes the two agree by
 *     construction; re-deriving would silently disagree for the stratified
 *     majority of every cell.
 */
export type MixContext =
	| { readonly kind: 'decide'; readonly input: MixAssignmentInput }
	| { readonly kind: 'assigned'; readonly arm: MixArm };

/**
 * Calibration slice size for a cell (D8): 10% below `s = 0.5`, 5% at or above
 * it, 0% once the cell graduates.
 *
 * GRADUATION NEEDS NO PARAMETER HERE. A graduated cell is by definition one
 * pinned at `s = 1` (D9), which is the degenerate case below: both arms of the
 * split are the same arm, so a "randomized" slice would carry no comparison at
 * all — marking rows `isCalibration` there would feed the engagement-ratio gate
 * a one-armed sample. `s = 0` is the mirror image. A separate `isGraduated`
 * knob would have been a second, unwired way to say what the share already
 * says; if P3 ever needs to zero the slice at a share below the ceiling, it can
 * add the parameter then.
 */
export function calibrationSliceFor(ownShare: number): number {
	const share = clampOwnShare(ownShare);
	if (share <= OWN_SHARE_FLOOR || share >= OWN_SHARE_CEILING) return 0;
	return share < CALIBRATION_WIDE_SLICE_MAX_SHARE
		? CALIBRATION_SLICE_BELOW_HALF
		: CALIBRATION_SLICE_AT_OR_ABOVE_HALF;
}

function normalizeMixVersion(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MIX_VERSION;
	return Math.trunc(value);
}

function normalizeRank(value: number | undefined): number | null {
	if (value === undefined || !Number.isFinite(value)) return null;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

function identityKey(recipient: MixRecipientIdentity): string | null {
	const key = recipient.contactId ?? recipient.fallbackKey;
	return key !== undefined && key !== '' ? key : null;
}

/**
 * The hash namespaces this module partitions its bucket space into. A CLOSED
 * set, and typed: the arm bucket and the calibration bucket must never be able
 * to agree, and a typo that made them agree would silently correlate slice
 * membership with the arm — a bias no downstream test could distinguish from a
 * real effect.
 */
export type MixHashConsumer =
	/** The arm bucket. */
	| 'arm'
	/** The randomized calibration slice. */
	| 'calibration'
	/** Tie dispersion inside an engagement-rank group (see below). */
	| 'rank';

/**
 * THE ANTI-COHORT SALT (D7), resolved.
 *
 * A campaign passes its campaign id. A send with NO campaign — the whole
 * `automation` and `transactional` streams — passes its send id as the fallback
 * key, and THAT is the salt: a constant salt segment there would pin a contact
 * to one arm for the entire life of a mix version, which is precisely the two
 * fixed cohorts D7 exists to prevent, and `automation` is a first-class
 * high-volume stream. With the send id in the salt the arm is re-drawn per
 * MESSAGE and stays stable within one message, which is exactly the property
 * the assignment row records.
 */
function saltFor(recipient: MixRecipientIdentity): string {
	return recipient.campaignId ?? recipient.fallbackKey ?? '';
}

/**
 * The salted key. The salt segment is present even when empty so the key SHAPE
 * is fixed: a key built from two segments and a key built from three must not
 * be able to collide.
 */
function mixKey(
	consumer: MixHashConsumer,
	key: string,
	recipient: MixRecipientIdentity,
	version: number
) {
	return `${consumer}|${key}:${saltFor(recipient)}:${version}`;
}

/**
 * The recipient's bucket in ONE hash partition, or `null` when there is no
 * stable identity to hash. The partition is the only thing that varies between
 * the arm draw and the calibration draw, so it is the only parameter: two
 * copies of this body differing by a string literal is exactly how the two
 * partitions would eventually drift into agreeing.
 */
function partitionBucketFor(
	consumer: MixHashConsumer,
	recipient: MixRecipientIdentity,
	mixVersion?: number
): number | null {
	const key = identityKey(recipient);
	if (key === null) return null;
	return bucketFor(mixKey(consumer, key, recipient, normalizeMixVersion(mixVersion)));
}

/**
 * The recipient's arm bucket. Exported so tests assert against the key shape
 * this module OWNS rather than hand-rebuilding it — a test that rebuilds the
 * key keeps passing after the key changes, while testing a format the code no
 * longer produces.
 */
export function armBucketFor(recipient: MixRecipientIdentity, mixVersion?: number): number | null {
	return partitionBucketFor('arm', recipient, mixVersion);
}

/** The recipient's calibration-slice bucket, from its own partition. */
export function calibrationBucketFor(
	recipient: MixRecipientIdentity,
	mixVersion?: number
): number | null {
	return partitionBucketFor('calibration', recipient, mixVersion);
}

/**
 * A stable `[0,1)` draw for ONE key, used by the rank producer to disperse a
 * tied engagement group across the percentile interval the group occupies.
 *
 * Its own partition, and deliberately NOT salted with the mix version or the
 * campaign: it must be independent of the arm bucket (or the "random" tie-break
 * would correlate with the arm and re-introduce the bias it exists to remove),
 * and it is a property of the recipient's place in a cohort rather than of a
 * controller decision.
 */
export function rankTieBreakUnit(key: string): number {
	const consumer: MixHashConsumer = 'rank';
	return bucketFor(`${consumer}|${key}`) / MIX_BUCKET_SPACE;
}

/**
 * Decide one recipient's arm.
 *
 * Evaluation order is load-bearing:
 *   1. the degenerate shares short-circuit, so `s = 0` reproduces today's
 *      routing EXACTLY and `s = 1` is unconditionally the own arm;
 *   2. an unidentifiable recipient fails closed to the reference arm — never
 *      to the own arm, which is the arm that costs reputation to get wrong;
 *   3. the calibration slice is decided BEFORE stratification, because a slice
 *      that stratification could veto would not be a random sample;
 *   4. stratification applies only to the rest, and only with a known rank.
 */
export function decideMixAssignment(input: MixAssignmentInput): MixAssignment {
	const ownShare = clampOwnShare(input.cell.ownShare);
	const mixVersion = normalizeMixVersion(input.cell.mixVersion);

	// BEFORE the hash, not after: until the controller starts writing shares
	// every cell resolves to one of these two, and the bucket a degenerate
	// decision would compute is recorded nowhere — `sendAssignments` has no
	// bucket column. Hashing a ~60-character key per recipient per page for a
	// value that is then discarded is the whole campaign's cost for nothing.
	if (ownShare <= OWN_SHARE_FLOOR) {
		return {
			arm: 'reference',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket: null,
			basis: 'degenerate_reference',
		};
	}
	if (ownShare >= OWN_SHARE_CEILING) {
		return {
			arm: 'own',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket: null,
			basis: 'degenerate_own',
		};
	}

	const bucket = armBucketFor(input.recipient, mixVersion);
	if (bucket === null) {
		return {
			arm: 'reference',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket: null,
			basis: 'unidentified',
		};
	}

	const threshold = Math.round(ownShare * MIX_BUCKET_SPACE);
	const sliceThreshold = Math.round(calibrationSliceFor(ownShare) * MIX_BUCKET_SPACE);
	// Its own hash namespace, and — critically — no engagement rank anywhere in
	// the key. Slice membership must be independent of engagement, or the gate
	// that reads it is measuring cohort quality again (D8).
	//
	// An identity-less recipient never reaches here: it has nothing stable to
	// join a randomized comparison on, so it fails closed to the reference arm
	// above and is simply not in the slice.
	const sliceBucket = calibrationBucketFor(input.recipient, mixVersion);
	const isCalibration = sliceBucket !== null && sliceBucket < sliceThreshold;

	if (isCalibration) {
		return {
			arm: bucket < threshold ? 'own' : 'reference',
			isCalibration: true,
			ownShare,
			mixVersion,
			bucket,
			basis: 'calibration',
		};
	}

	const rank = normalizeRank(input.recipient.engagementRank);
	if (rank !== null) {
		// The TOP `s` fraction. The plan sketch writes this as `rank < s`, which
		// assumes a DESCENDING rank (0 = most engaged); the shipped
		// `engagementPercentile` is ASCENDING (1 = most engaged), and inverting
		// the comparison here rather than the rank keeps one definition of
		// "percentile" in the codebase.
		//
		// The cutoff lives in RANK space, so it is written as the literal 1 and
		// not as the share-space ceiling constant: the two domains happen to
		// share an upper bound, which is a coincidence and not a meaning.
		const stratifiedRankCutoff = 1 - ownShare;
		return {
			arm: rank >= stratifiedRankCutoff ? 'own' : 'reference',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket,
			basis: 'stratified',
			engagementRank: rank,
		};
	}

	return {
		arm: bucket < threshold ? 'own' : 'reference',
		isCalibration: false,
		ownShare,
		mixVersion,
		bucket,
		basis: 'random',
	};
}
