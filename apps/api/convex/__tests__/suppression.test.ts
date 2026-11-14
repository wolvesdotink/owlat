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
import { afterEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { isSuppressed, loadSuppressionSet, suppressEmail } from '../lib/suppression';
import { SOFT_BOUNCE_SUPPRESSION_TTL_MS } from '@owlat/shared/softBounceSuppression';
import { applyEffects } from '../delivery/sendLifecycle/effects';
import { normalizeEmail } from '../lib/inputGuards';

const modules = import.meta.glob('../**/*.*s');

/** Insert a `blockedEmails` row. The blocklist stores normalized addresses. */
async function block(t: ReturnType<typeof convexTest>, email: string): Promise<void> {
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

describe('soft-bounce expiry', () => {
	const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
	afterEach(() => {
		vi.useRealTimers();
	});

	async function seedBounces(t: ReturnType<typeof convexTest>): Promise<void> {
		await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'full@example.com',
				reason: 'bounced',
				bounceType: 'soft',
				createdAt: T0,
			});
			await ctx.db.insert('blockedEmails', {
				email: 'gone@example.com',
				reason: 'bounced',
				bounceType: 'hard',
				createdAt: T0,
			});
		});
	}

	it('a soft-bounce block stops blocking after the window, a hard bounce does not', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = convexTest(schema, modules);
		await seedBounces(t);
		const blocked = (email: string) =>
			t.run((ctx) => isSuppressed(ctx, email, { scope: 'transactional' }));

		vi.setSystemTime(T0 + SOFT_BOUNCE_SUPPRESSION_TTL_MS - 1);
		expect(await blocked('full@example.com')).toBe(true);

		vi.setSystemTime(T0 + SOFT_BOUNCE_SUPPRESSION_TTL_MS);
		expect(await blocked('full@example.com')).toBe(false);
		expect(await blocked('gone@example.com')).toBe(true);
		const set = await t.run(async (ctx) => [...(await loadSuppressionSet(ctx))]);
		expect(set).toEqual(['gone@example.com']);
	});

	it('a soft bounce that upgrades an old unengaged row starts its own window', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = convexTest(schema, modules);
		const sendId = await t.run(async (ctx) => {
			await ctx.db.insert('blockedEmails', {
				email: 'quiet@example.com',
				reason: 'unengaged',
				createdAt: T0 - 3 * SOFT_BOUNCE_SUPPRESSION_TTL_MS,
			});
			return await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'quiet@example.com',
				status: 'queued',
			});
		});

		await t.run((ctx) =>
			applyEffects(ctx, [
				{
					kind: 'blocklist_insert',
					email: 'quiet@example.com',
					reason: 'bounced',
					bounceType: 'soft',
					source: { kind: 'transactional', id: sendId },
				},
			])
		);

		expect(
			await t.run((ctx) => isSuppressed(ctx, 'quiet@example.com', { scope: 'transactional' }))
		).toBe(true);
	});

	it('a complaint replaces an active soft-bounce row instead of being dropped', async () => {
		vi.useFakeTimers({ now: T0 });
		const t = convexTest(schema, modules);
		await seedBounces(t);

		await t.run((ctx) => suppressEmail(ctx, { email: 'full@example.com', reason: 'complained' }));

		vi.setSystemTime(T0 + 2 * SOFT_BOUNCE_SUPPRESSION_TTL_MS);
		const rows = await t.run((ctx) =>
			ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', 'full@example.com'))
				.collect()
		);
		expect(rows.map((r) => [r.reason, r.bounceType])).toEqual([['complained', undefined]]);
		expect(
			await t.run((ctx) => isSuppressed(ctx, 'full@example.com', { scope: 'transactional' }))
		).toBe(true);
	});
});
