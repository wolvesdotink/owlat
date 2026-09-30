/**
 * The row-level trust transitions behind `e2ee/recipientKeys.ts`: how a
 * discovery miss and a discovered key are written onto a `recipientKeys` row.
 * Kept apart from the Convex functions so the commit mutation and its v0.6.5
 * compatibility shim share one implementation of the TOFU write (the decision
 * itself stays in the pure `e2ee/pinning.ts`).
 *
 * Callers decide WHICH row state a write may be made against (the commit path
 * checks the revision the discovery read); these helpers only apply it.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader, DatabaseWriter } from '../_generated/server';
import { evaluatePin, fingerprintsEqual } from './pinning';

/**
 * The recipient-key row for an address, plus its trust revision (0 for a row
 * written before the field existed, or for no row at all).
 */
export async function loadRow(ctx: { db: DatabaseReader }, address: string) {
	const row = await ctx.db
		.query('recipientKeys')
		.withIndex('by_address', (q) => q.eq('address', address))
		.first();
	return { row, revision: row?.revision ?? 0 };
}

/** Pin equality where "no pin" is a value of its own. */
export function samePin(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return !a && !b;
	return fingerprintsEqual(a, b);
}

type RecipientKeyRow = Doc<'recipientKeys'>;

/** A discovery miss (no usable key, or the lookup failed). */
interface MissInput {
	domain: string;
	instanceFingerprint?: string;
	expiresAt: number;
}

/**
 * Write a miss onto `row` (or a fresh negative entry). Freshness/discovery
 * metadata only: the pin, the observed key and a pinned row's outcome are never
 * touched, and the revision does not move.
 */
export async function writeMiss(
	ctx: { db: DatabaseWriter },
	address: string,
	row: RecipientKeyRow | null,
	input: MissInput
): Promise<{ id: Id<'recipientKeys'>; created: boolean }> {
	const now = Date.now();
	if (row) {
		await ctx.db.patch(row._id, {
			outcome: row.pinnedFingerprint ? row.outcome : 'notFound',
			instanceFingerprint: input.instanceFingerprint ?? row.instanceFingerprint,
			expiresAt: input.expiresAt,
			updatedAt: now,
		});
		return { id: row._id, created: false };
	}
	const id = await ctx.db.insert('recipientKeys', {
		address,
		domain: input.domain.toLowerCase(),
		outcome: 'notFound',
		instanceFingerprint: input.instanceFingerprint,
		expiresAt: input.expiresAt,
		revision: 0,
		discoveredAt: now,
		updatedAt: now,
	});
	return { id, created: true };
}

/** A discovered key, with the rotation proof (if any) the action verified. */
interface DiscoveredKeyInput extends MissInput {
	fingerprint: string;
	publicKeyArmored: string;
	source: 'wkd' | 'manifest';
	rotation?: { oldFingerprint: string; newFingerprint: string };
}

/**
 * Run the TOFU state machine for `input` against `row` and write the result.
 * The caller has established that `row`/`revision` are the state the decision
 * may be made against.
 */
export async function writeDiscoveredKey(
	ctx: { db: DatabaseWriter },
	address: string,
	row: RecipientKeyRow | null,
	revision: number,
	input: DiscoveredKeyInput
) {
	const now = Date.now();
	const pinned = row?.pinnedFingerprint ?? null;
	const rotation = input.rotation;
	const rotationSignatureValid =
		rotation !== undefined &&
		pinned !== null &&
		fingerprintsEqual(rotation.oldFingerprint, pinned) &&
		fingerprintsEqual(rotation.newFingerprint, input.fingerprint);
	const decision = evaluatePin({
		pinnedFingerprint: pinned,
		observedFingerprint: input.fingerprint,
		rotationSignatureValid,
	});

	// On `keyChanged` the pin stays the OLD key; otherwise the observed key
	// becomes the trusted pin.
	const trustedIsObserved = decision.state === 'pinned';
	const outcome = trustedIsObserved ? ('trusted' as const) : ('keyChanged' as const);
	const fields = {
		domain: input.domain.toLowerCase(),
		outcome,
		pinnedFingerprint: decision.pinnedFingerprint,
		pinnedPublicKeyArmored: trustedIsObserved
			? input.publicKeyArmored
			: row?.pinnedPublicKeyArmored,
		observedFingerprint: decision.observedFingerprint,
		observedPublicKeyArmored: input.publicKeyArmored,
		source: input.source,
		instanceFingerprint: input.instanceFingerprint ?? row?.instanceFingerprint,
		expiresAt: input.expiresAt,
		updatedAt: now,
	};

	let id: Id<'recipientKeys'>;
	if (row) {
		// A plain refresh of the same state keeps the revision, so concurrent
		// refreshes of an unchanged key do not force each other to start over.
		const transitioned =
			row.outcome !== outcome ||
			!samePin(row.pinnedFingerprint, decision.pinnedFingerprint) ||
			!samePin(row.observedFingerprint, decision.observedFingerprint);
		await ctx.db.patch(row._id, { ...fields, revision: transitioned ? revision + 1 : revision });
		id = row._id;
	} else {
		id = await ctx.db.insert('recipientKeys', {
			address,
			...fields,
			revision: 1,
			discoveredAt: now,
		});
	}
	return { id, created: !row, outcome, action: decision.action };
}
