import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

// The glob runs from this `campaigns/__tests__/` dir, so sibling modules come
// back keyed `../<name>` (one level up). convex-test resolves the internal API
// path `campaigns/<name>`, so remap those keys back under `campaigns/`.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../campaigns/' + key.slice(3), val];
		}
		return [key, val];
	}),
);

describe('urlReputationCache internal functions', () => {
	it('returns null for an unknown url hash', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(internal.campaigns.sendQueries.getUrlReputationVerdict, {
			urlHash: 'no-such-hash',
		});
		expect(result).toBeNull();
	});

	it('stores a verdict and reads it back within TTL', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.mutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
			urlHash: 'hash-a',
			verdict: 'malicious',
			source: 'google_safe_browsing',
			threats: ['MALWARE'],
			checkedAt: now,
			expiresAt: now + 60_000,
		});

		const result = await t.query(internal.campaigns.sendQueries.getUrlReputationVerdict, {
			urlHash: 'hash-a',
		});
		expect(result).not.toBeNull();
		expect(result?.verdict).toBe('malicious');
		expect(result?.source).toBe('google_safe_browsing');
		expect(result?.threats).toEqual(['MALWARE']);

		// Exactly one row was written for the hash.
		const rows = await t.run(async (ctx) =>
			ctx.db.query('urlReputationCache').collect(),
		);
		expect(rows).toHaveLength(1);
	});

	it('treats an expired verdict as a cache miss', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.mutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
			urlHash: 'hash-expired',
			verdict: 'safe',
			source: 'google_safe_browsing',
			checkedAt: now - 120_000,
			expiresAt: now - 60_000,
		});

		const result = await t.query(internal.campaigns.sendQueries.getUrlReputationVerdict, {
			urlHash: 'hash-expired',
		});
		expect(result).toBeNull();
	});

	it('upserts (replaces) an existing verdict instead of duplicating rows', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.mutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
			urlHash: 'hash-up',
			verdict: 'suspicious',
			source: 'google_safe_browsing',
			checkedAt: now,
			expiresAt: now + 60_000,
		});
		await t.mutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
			urlHash: 'hash-up',
			verdict: 'safe',
			source: 'google_safe_browsing',
			checkedAt: now + 1,
			expiresAt: now + 60_001,
		});

		const rows = await t.run(async (ctx) =>
			ctx.db.query('urlReputationCache').collect(),
		);
		expect(rows).toHaveLength(1);

		const result = await t.query(internal.campaigns.sendQueries.getUrlReputationVerdict, {
			urlHash: 'hash-up',
		});
		expect(result?.verdict).toBe('safe');
	});
});

describe('sendQueries.getOrgTimezone', () => {
	it('returns null when no instanceSettings row exists', async () => {
		// Convex serializes an `undefined` return to `null` across the function
		// boundary; callers coerce it back with `?? undefined`.
		const t = convexTest(schema, modules);
		const result = await t.query(internal.campaigns.sendQueries.getOrgTimezone, {});
		expect(result).toBeNull();
	});

	it('returns the org-level timezone from the settings row', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				timezone: 'Europe/Berlin',
				createdAt: Date.now(),
			});
		});

		const result = await t.query(internal.campaigns.sendQueries.getOrgTimezone, {});
		expect(result).toBe('Europe/Berlin');
	});

	it('returns null when the settings row has no timezone set', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				defaultFromName: 'Acme',
				createdAt: Date.now(),
			});
		});

		const result = await t.query(internal.campaigns.sendQueries.getOrgTimezone, {});
		expect(result).toBeNull();
	});
});
