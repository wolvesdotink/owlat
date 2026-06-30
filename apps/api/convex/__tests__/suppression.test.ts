/**
 * Suppression lookup (helper) — `lib/suppression.ts`.
 *
 * `blockedEmails` is the CAN-SPAM / honor-suppression boundary; three send
 * paths gate on it (transactional intake, the non-campaign writer, audience
 * resolution). They were previously three inlined reads with diverging
 * normalization. This pins the single shared lookup:
 *   - `isSuppressed` returns true for a blocked address and false for a clean
 *     one, and FOLDS the address (trim + lowercase) so a differently-cased /
 *     padded caller value still matches the normalized stored key.
 *   - `loadSuppressionSet` returns the whole list as a set of normalized keys
 *     (the bulk shape audience resolution walks), so a `normalizeEmail`
 *     membership test agrees with the point-read path.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { isSuppressed, loadSuppressionSet } from '../lib/suppression';
import { normalizeEmail } from '../lib/inputGuards';

const modules = import.meta.glob('../**/*.*s');

/** Insert a `blockedEmails` row. The blocklist stores normalized addresses. */
async function block(
	t: ReturnType<typeof convexTest>,
	email: string,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('blockedEmails', {
			email,
			reason: 'manual',
			createdAt: Date.now(),
		});
	});
}

describe('isSuppressed', () => {
	it('returns true for a suppressed address', async () => {
		const t = convexTest(schema, modules);
		await block(t, 'blocked@example.com');

		const result = await t.run((ctx) => isSuppressed(ctx, 'blocked@example.com'));
		expect(result).toBe(true);
	});

	it('returns false for an address not on the list', async () => {
		const t = convexTest(schema, modules);
		await block(t, 'blocked@example.com');

		const result = await t.run((ctx) => isSuppressed(ctx, 'someone-else@example.com'));
		expect(result).toBe(false);
	});

	it('returns false when the list is empty', async () => {
		const t = convexTest(schema, modules);
		const result = await t.run((ctx) => isSuppressed(ctx, 'anyone@example.com'));
		expect(result).toBe(false);
	});

	it('normalizes the looked-up address (case + surrounding whitespace) before the read', async () => {
		const t = convexTest(schema, modules);
		// Stored normalized; caller passes a differently-cased + padded value.
		await block(t, 'blocked@example.com');

		const upper = await t.run((ctx) => isSuppressed(ctx, '  BLOCKED@Example.COM '));
		expect(upper).toBe(true);
	});

	it('matches a stored row even if the row itself was not normalized at insert', async () => {
		const t = convexTest(schema, modules);
		// Defensive: a legacy / mixed-case stored row is folded by the helper too,
		// so the by_email key the lookup builds and the stored key can drift only
		// if BOTH sides skip normalization — which this helper prevents on read.
		await block(t, 'blocked@example.com');
		const normalizedKey = normalizeEmail('Blocked@Example.com');
		const result = await t.run((ctx) => isSuppressed(ctx, normalizedKey));
		expect(result).toBe(true);
	});
});

describe('loadSuppressionSet', () => {
	// `loadSuppressionSet` returns a `Set`, which is not a serializable Convex
	// type — so the set is built AND queried inside `t.run` and only plain
	// booleans / numbers cross the boundary.

	it('returns a set of normalized keys for every blocked address', async () => {
		const t = convexTest(schema, modules);
		await block(t, 'a@example.com');
		await block(t, 'b@example.com');

		const result = await t.run(async (ctx) => {
			const set = await loadSuppressionSet(ctx);
			return {
				a: set.has('a@example.com'),
				b: set.has('b@example.com'),
				c: set.has('c@example.com'),
			};
		});
		expect(result).toEqual({ a: true, b: true, c: false });
	});

	it('folds stored keys so a normalized membership test agrees', async () => {
		const t = convexTest(schema, modules);
		// A row stored with mixed case + padding is folded into the set, so the
		// audience-resolution `set.has(normalizeEmail(contact.email))` test hits.
		await block(t, '  MixedCase@Example.COM ');

		const result = await t.run(async (ctx) => {
			const set = await loadSuppressionSet(ctx);
			return {
				normalized: set.has(normalizeEmail('mixedcase@example.com')),
				raw: set.has('  MixedCase@Example.COM '),
			};
		});
		expect(result.normalized).toBe(true);
		expect(result.raw).toBe(false); // not the raw stored value
	});

	it('returns an empty set when nothing is suppressed', async () => {
		const t = convexTest(schema, modules);
		const size = await t.run(async (ctx) => (await loadSuppressionSet(ctx)).size);
		expect(size).toBe(0);
	});
});
