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
