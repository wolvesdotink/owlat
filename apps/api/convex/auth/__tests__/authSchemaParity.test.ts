import { describe, expect, it } from 'vitest';
import { getAuthTables } from 'better-auth/db';
import type { ActionCtx } from '../../_generated/server';
import { createAuthOptions } from '../auth';
import { tables } from '../../betterAuth/schema';

/**
 * `convex/betterAuth/schema.ts` is a HAND-MAINTAINED mirror of the tables
 * BetterAuth derives from the option object — the header of that file says as
 * much, because `npx auth generate` cannot run against a factory that needs an
 * ActionCtx. A hand-maintained mirror drifts silently: enabling a plugin adds
 * fields to the derived schema, the mirror keeps the old shape, and because
 * Convex rejects a write that carries an undeclared field, the drift surfaces
 * only at runtime as a failed auth request.
 *
 * That is exactly how the two-factor plugin landed: it writes
 * `twoFactor.failedVerificationCount` and `twoFactor.lockedUntil` on every
 * failed code, so the first wrong TOTP digit — not enrolment, not sign-in —
 * would have been the first thing to throw.
 *
 * So: every model BetterAuth declares must exist in the mirror, and every field
 * on it must be declared there too. The mirror is allowed to carry EXTRA tables
 * and fields (it keeps the passkey/oauth tables for plugins that are not wired
 * yet, and `session.activeOrganizationId`), so the check runs one way only.
 */

// Schema derivation reads only the static option shape — the ctx is never
// touched. Same contract as authOptionsSecret.test.ts / changeEmail.test.ts.
const ctx = {} as ActionCtx;

type MirrorTable = { validator: { fields: Record<string, unknown> } };

function mirrorFields(tableName: string): string[] | null {
	const table = (tables as unknown as Record<string, MirrorTable | undefined>)[tableName];
	if (!table) return null;
	return Object.keys(table.validator.fields);
}

describe('betterAuth component schema mirrors the derived auth tables', () => {
	const derived = getAuthTables(createAuthOptions(ctx));

	it('derives more than the core tables (the plugins are actually wired)', () => {
		// Guards the guard: if `createAuthOptions` ever stopped returning plugins,
		// every assertion below would pass vacuously.
		expect(Object.keys(derived)).toEqual(expect.arrayContaining(['twoFactor', 'organization']));
	});

	it('declares every table BetterAuth derives', () => {
		const missing = Object.values(derived)
			.map((table) => table.modelName)
			.filter((modelName) => mirrorFields(modelName) === null);
		expect(missing).toEqual([]);
	});

	it('declares every field BetterAuth derives, on every table', () => {
		const drift: Record<string, string[]> = {};
		for (const table of Object.values(derived)) {
			const declared = mirrorFields(table.modelName);
			if (declared === null) continue; // reported by the table check above
			const missing = Object.values(table.fields)
				.map((field, index) => field.fieldName ?? Object.keys(table.fields)[index]!)
				.filter((fieldName) => !declared.includes(fieldName));
			if (missing.length > 0) drift[table.modelName] = missing;
		}
		expect(drift).toEqual({});
	});

	it('keeps the two-factor lockout counters, which Convex must declare to accept', () => {
		// Named explicitly: these two are the fields a `verified`-only mirror is
		// missing, and the failure they cause (a wrong code 500s instead of being
		// counted) is easy to mistake for a plugin bug.
		expect(mirrorFields('twoFactor')).toEqual(
			expect.arrayContaining(['failedVerificationCount', 'lockedUntil'])
		);
	});
});
