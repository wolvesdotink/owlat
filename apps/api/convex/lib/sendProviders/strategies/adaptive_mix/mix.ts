/**
 * The mix decision — PURE (plan D15).
 *
 * Given a cell's share and one recipient's identity, decide which arm the
 * recipient belongs to and whether it belongs to the randomized calibration
 * slice. No clock, no database, no environment, no `Math.random()`: the one
 * source of non-determinism the algorithm can need (a recipient with no stable
 * identity at all) arrives as the `randomUnit` PARAMETER, so every branch is
 * reproducible from a fixture.
 *
 * THE ANTI-COHORT PROPERTY (D7) is the reason this file exists. Salting the
 * hash with `contactId` alone would put a contact in the same arm for every
 * campaign forever: the two arms would then be two fixed COHORTS, and every
 * ratio the controller reads would be a comparison of cohort quality rather
 * than of transport quality. The `campaignId` salt is what makes the arms
 * comparable; the `mixVersion` salt re-randomizes the whole population every
 * time the controller moves the share, so a share change is a fresh draw and
 * not a re-labelling of the previous one.
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

export const MIX_ARMS = ['own', 'reference'] as const;
export type MixArm = (typeof MIX_ARMS)[number];

/** Share below which the calibration slice is the wider 10%. */
export const CALIBRATION_WIDE_SLICE_MAX_SHARE = 0.5;
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
	/**
	 * Stratified assignment is the DEFAULT (D8); an explicit `false` selects
	 * pure hash assignment for the whole cell.
	 */
	readonly isStratified?: boolean | undefined;
	/** A graduated cell has no calibration slice left to carve (D9). */
	readonly isGraduated?: boolean | undefined;
}

export interface MixRecipientIdentity {
	/** The stable per-recipient salt. Absent for a send with no contact row. */
	readonly contactId?: string | undefined;
	/** THE anti-cohort salt (D7). */
	readonly campaignId?: string | undefined;
	/**
	 * Engagement percentile in `[0,1]`, 1 = most engaged, as produced by
	 * `analytics/engagementScore.ts engagementPercentile` over this cell's
	 * cohort. Absent means "unknown", which falls back to the random bucket —
	 * never to the own arm.
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
	/**
	 * A `[0,1)` draw, used ONLY when the recipient has neither a contact id nor
	 * a fallback key. Passed in rather than drawn here so the decision function
	 * stays pure (D15).
	 */
	readonly randomUnit?: number | undefined;
}

export interface MixAssignment {
	readonly arm: MixArm;
	readonly isCalibration: boolean;
	/** The resolved, clamped share this decision was taken against. */
	readonly ownShare: number;
	readonly mixVersion: number;
	/** The recipient's slot in `[0, MIX_BUCKET_SPACE)`. */
	readonly bucket: number;
	readonly basis: MixAssignmentBasis;
	/** The rank actually used, when the decision was stratified. */
	readonly engagementRank?: number;
}

/**
 * Calibration slice size for a cell (D8): 10% below `s = 0.5`, 5% at or above
 * it, 0% once the cell graduates.
 *
 * A DEGENERATE cell (`s = 0` or `s = 1`) also has no slice: both arms of the
 * split are the same arm, so a "randomized" slice would carry no comparison at
 * all — marking rows `isCalibration` there would feed the engagement-ratio gate
 * a sample with only one arm in it.
 */
export function calibrationSliceFor(ownShare: number, isGraduated = false): number {
	if (isGraduated) return 0;
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

function randomBucket(randomUnit: number | undefined): number | null {
	if (randomUnit === undefined || !Number.isFinite(randomUnit)) return null;
	if (randomUnit <= 0) return 0;
	if (randomUnit >= 1) return MIX_BUCKET_SPACE - 1;
	return Math.min(MIX_BUCKET_SPACE - 1, Math.floor(randomUnit * MIX_BUCKET_SPACE));
}

/**
 * The salted key. `campaignId` is part of the salt even when absent (as the
 * empty segment) so the key SHAPE is fixed: a key built from two segments and a
 * key built from three must not be able to collide.
 */
function mixKey(consumer: string, key: string, recipient: MixRecipientIdentity, version: number) {
	return `${consumer}|${key}:${recipient.campaignId ?? ''}:${version}`;
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
	const key = identityKey(input.recipient);
	const bucket =
		key !== null
			? bucketFor(mixKey('arm', key, input.recipient, mixVersion))
			: randomBucket(input.randomUnit);

	if (ownShare <= OWN_SHARE_FLOOR) {
		return {
			arm: 'reference',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket: bucket ?? 0,
			basis: 'degenerate_reference',
		};
	}
	if (ownShare >= OWN_SHARE_CEILING) {
		return {
			arm: 'own',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket: bucket ?? 0,
			basis: 'degenerate_own',
		};
	}
	if (bucket === null) {
		return {
			arm: 'reference',
			isCalibration: false,
			ownShare,
			mixVersion,
			bucket: 0,
			basis: 'unidentified',
		};
	}

	const threshold = Math.round(ownShare * MIX_BUCKET_SPACE);
	const sliceThreshold = Math.round(
		calibrationSliceFor(ownShare, input.cell.isGraduated ?? false) * MIX_BUCKET_SPACE
	);
	// Its own hash namespace, and — critically — no engagement rank anywhere in
	// the key. Slice membership must be independent of engagement, or the gate
	// that reads it is measuring cohort quality again (D8).
	const sliceBucket =
		key !== null
			? bucketFor(mixKey('calibration', key, input.recipient, mixVersion))
			: randomBucket(input.randomUnit);
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

	const rank =
		input.cell.isStratified === false ? null : normalizeRank(input.recipient.engagementRank);
	if (rank !== null) {
		// The TOP `s` fraction. The plan sketch writes this as `rank < s`, which
		// assumes a DESCENDING rank (0 = most engaged); the shipped
		// `engagementPercentile` is ASCENDING (1 = most engaged), and inverting
		// the comparison here rather than the rank keeps one definition of
		// "percentile" in the codebase.
		return {
			arm: rank >= OWN_SHARE_CEILING - ownShare ? 'own' : 'reference',
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
