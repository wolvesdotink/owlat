/**
 * Shared synthetic-audience helpers for the `adaptive_mix` suite.
 *
 * A statistical assertion is only as trustworthy as the population it runs
 * over, so every file in this suite draws its audience from the SAME generator:
 * stable, non-random ids that look like the Convex ids production feeds the
 * hash (`k57...`-shaped, structured, sequential), because a generator that
 * emits UUIDs would hide exactly the input-shape sensitivity the hash has to
 * survive.
 */

import {
	decideMixAssignment,
	type MixArm,
	type MixAssignment,
	type MixCellState,
	type MixRecipientIdentity,
} from '../adaptive_mix';
import { buildEngagementRanker } from '../../../../delivery/sendAssignmentRouting';

/** Deterministic, structured ids — the adversarial shape, not random noise. */
export function syntheticContactIds(count: number, prefix = 'jd7'): string[] {
	const ids: string[] = [];
	for (let index = 0; index < count; index += 1) {
		ids.push(`${prefix}${String(index).padStart(12, '0')}`);
	}
	return ids;
}

export function assignAll(
	contactIds: readonly string[],
	cell: MixCellState,
	recipient: Omit<MixRecipientIdentity, 'contactId'> = {}
): MixAssignment[] {
	return contactIds.map((contactId) =>
		decideMixAssignment({ cell, recipient: { ...recipient, contactId } })
	);
}

export function shareOfArm(assignments: readonly MixAssignment[], arm: MixArm): number {
	if (assignments.length === 0) return 0;
	return assignments.filter((assignment) => assignment.arm === arm).length / assignments.length;
}

export function calibrationShare(assignments: readonly MixAssignment[]): number {
	if (assignments.length === 0) return 0;
	return assignments.filter((assignment) => assignment.isCalibration).length / assignments.length;
}

/** Fold rather than `Math.min(...array)`: the audiences overflow the arg limit. */
export function minOf(values: readonly number[]): number {
	return values.reduce((low, value) => (value < low ? value : low), Number.POSITIVE_INFINITY);
}

export function maxOf(values: readonly number[]): number {
	return values.reduce((high, value) => (value > high ? value : high), Number.NEGATIVE_INFINITY);
}

export function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Pearson correlation between a boolean flag (0/1) and a numeric value. */
export function pointBiserial(flags: readonly boolean[], values: readonly number[]): number {
	const n = flags.length;
	const flagValues = flags.map((flag) => (flag ? 1 : 0));
	const meanFlag = mean(flagValues);
	const meanValue = mean(values);
	let cov = 0;
	let varFlag = 0;
	let varValue = 0;
	for (let index = 0; index < n; index += 1) {
		const dFlag = (flagValues[index] ?? 0) - meanFlag;
		const dValue = (values[index] ?? 0) - meanValue;
		cov += dFlag * dValue;
		varFlag += dFlag * dFlag;
		varValue += dValue * dValue;
	}
	if (varFlag === 0 || varValue === 0) return 0;
	return cov / Math.sqrt(varFlag * varValue);
}

/**
 * Ranks produced the way PRODUCTION produces them: real engagement scores fed
 * through the shipped percentile helper and the ranker's tie dispersion.
 *
 * This is the fixture the tie defect hides from. A synthetic set of DISTINCT
 * uniform ranks is the one distribution in which `engagementPercentile`'s
 * tie behaviour cannot surface at all, so every share assertion over it passes
 * whether or not ties are handled — while a real cold list is usually mostly
 * tied, and an all-zero list is entirely tied.
 */
export function ranksFromScores(
	sendIds: readonly string[],
	scores: readonly number[]
): Array<number | undefined> {
	const recipients = sendIds.map((sendId, index) => ({
		sendId,
		email: `u${index}@gmail.com`,
		...(scores[index] !== undefined ? { engagementScore: scores[index] } : {}),
	}));
	const rankFor = buildEngagementRanker(recipients);
	return recipients.map((recipient) => rankFor(recipient));
}

/** Assign a whole audience whose ranks are supplied positionally. */
export function assignRanked(
	contactIds: readonly string[],
	ranks: ReadonlyArray<number | undefined>,
	cell: MixCellState,
	recipient: Omit<MixRecipientIdentity, 'contactId' | 'engagementRank'> = {}
): MixAssignment[] {
	return contactIds.map((contactId, index) => {
		const rank = ranks[index];
		return decideMixAssignment({
			cell,
			recipient: {
				...recipient,
				contactId,
				...(rank !== undefined ? { engagementRank: rank } : {}),
			},
		});
	});
}
