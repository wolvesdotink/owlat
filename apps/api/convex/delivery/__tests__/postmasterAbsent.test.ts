/**
 * The Convex half of the additive-only proof (D2).
 *
 * With no Google Postmaster account connected there are no rows, and the
 * delivery screen's query must answer with a calm "not connected" state: no
 * throw, no error field, no cards, no unresolvable warning. Sending is
 * unaffected either way — nothing in this path can block a send.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'owner' }),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

function dateDaysAgo(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

async function seedVerifiedDomain(t: ReturnType<typeof convexTest>): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('domains', {
			domain: 'verified.example',
			status: 'verified',
			dnsRecords: {},
			createdAt: now,
			updatedAt: now,
		});
	});
}

describe('Google Postmaster is absent', () => {
	it('reports "not connected" with no cards and no error when nothing was ever ingested', async () => {
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t);

		const status = await t.query(api.delivery.postmaster.getPostmasterStatus, {});

		expect(status.connected).toBe(false);
		expect(status.domains).toEqual([
			expect.objectContaining({ domain: 'verified.example', periodStart: null, cards: [] }),
		]);
	});

	it('answers cleanly for a deployment with no sending domains at all', async () => {
		const t = convexTest(schema, modules);

		await expect(t.query(api.delivery.postmaster.getPostmasterStatus, {})).resolves.toEqual({
			connected: false,
			domains: [],
		});
	});

	it('writes nothing and throws nothing when a verdict arrives for an unverified domain', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.delivery.postmaster.ingestCompliance, {
			domain: 'not-mine.example',
			date: dateDaysAgo(0),
			checks: [{ name: 'SPAM_RATE', state: 'failing' as const }],
			fetchedAt: Date.now(),
		});

		expect(result).toEqual({
			ingested: false,
			authorized: false,
			reason: 'domain_not_verified',
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.query('googlePostmasterCompliance').collect()).toEqual([]);
		});
	});

	it('turns connected once a verdict lands and surfaces it as an actionable card', async () => {
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t);

		await t.mutation(internal.delivery.postmaster.ingestCompliance, {
			domain: 'verified.example',
			date: dateDaysAgo(0),
			checks: [
				{ name: 'IP_REPUTATION', state: 'failing' as const },
				// A name we have no copy for is retained, not dropped.
				{ name: 'FUTURE_CHECK', state: 'failing' as const },
				// Not enum-shaped: dropped at the boundary, never stored.
				{ name: 'bad name', state: 'failing' as const },
			],
			fetchedAt: Date.now(),
		});

		const status = await t.query(api.delivery.postmaster.getPostmasterStatus, {});

		expect(status.connected).toBe(true);
		const domain = status.domains[0]!;
		expect(domain.checks.map((check) => check.name)).toEqual(['IP_REPUTATION', 'FUTURE_CHECK']);
		expect(domain.cards.map((card) => card.check)).toEqual(['IP_REPUTATION', 'FUTURE_CHECK']);
		expect(domain.cards[0]!.remedy).not.toHaveLength(0);
	});

	it('keeps a legacy statistics row without the widened v2 metrics readable', async () => {
		const t = convexTest(schema, modules);
		await seedVerifiedDomain(t);
		await t.mutation(internal.delivery.postmaster.ingest, {
			domain: 'verified.example',
			date: dateDaysAgo(1),
			userReportedSpamRatio: 0.0001,
			fetchedAt: Date.now(),
		});

		const status = await t.query(api.delivery.postmaster.getPostmasterStatus, {});

		expect(status.connected).toBe(true);
		expect(status.domains[0]).toMatchObject({
			userReportedSpamRatio: 0.0001,
			spfSuccessRatio: null,
			deliveryErrors: [],
			cards: [],
		});
	});
});
