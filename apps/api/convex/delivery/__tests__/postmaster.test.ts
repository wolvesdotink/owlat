import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { POSTMASTER_CLEANUP_BATCH_SIZE } from '../postmaster';

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

afterEach(() => vi.useRealTimers());

function dateDaysAgo(daysAgo: number): string {
	return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

describe('Google Postmaster telemetry ingestion', () => {
	it('accepts only exact verified domains and updates a domain/day idempotently', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			for (const [domain, status] of [
				['verified.example', 'verified'],
				['pending.example', 'pending'],
			] as const) {
				await ctx.db.insert('domains', {
					domain,
					status,
					dnsRecords: {},
					createdAt: now,
					updatedAt: now,
				});
			}
		});
		const base = {
			date: dateDaysAgo(1),
			userReportedSpamRatio: 0.001,
			fetchedAt: now,
		};
		await expect(
			t.mutation(internal.delivery.postmaster.authorizeDomain, {
				domain: 'missing.example',
			})
		).resolves.toEqual({ authorized: false });
		await expect(
			t.mutation(internal.delivery.postmaster.authorizeDomain, {
				domain: 'pending.example',
			})
		).resolves.toEqual({ authorized: false });
		await expect(
			t.mutation(internal.delivery.postmaster.authorizeDomain, {
				domain: 'verified.example',
			})
		).resolves.toEqual({ authorized: true });

		await expect(
			t.mutation(internal.delivery.postmaster.ingest, { ...base, domain: 'missing.example' })
		).resolves.toMatchObject({ ingested: false, reason: 'domain_not_verified' });
		await expect(
			t.mutation(internal.delivery.postmaster.ingest, { ...base, domain: 'pending.example' })
		).resolves.toMatchObject({ ingested: false, reason: 'domain_not_verified' });

		await t.mutation(internal.delivery.postmaster.ingest, {
			...base,
			domain: 'verified.example',
		});
		await t.mutation(internal.delivery.postmaster.ingest, {
			...base,
			domain: 'verified.example',
			userReportedSpamRatio: 0.002,
			fetchedAt: now + 1,
		});
		await expect(
			t.mutation(internal.delivery.postmaster.ingest, {
				...base,
				domain: 'verified.example',
				userReportedSpamRatio: 0.009,
			})
		).resolves.toMatchObject({ ingested: false, reason: 'stale_observation' });
		await expect(
			t.mutation(internal.delivery.postmaster.ingest, {
				...base,
				domain: 'verified.example',
				userReportedSpamRatio: 0.002,
				fetchedAt: now + 1,
			})
		).resolves.toMatchObject({ ingested: true, updated: false, replayed: true });

		const stored = await t.run((ctx) => ctx.db.query('googlePostmasterStats').collect());
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			domain: 'verified.example',
			userReportedSpamRatio: 0.002,
		});
		for (const unsupportedField of [
			'domainReputation',
			'ipReputations',
			'userReportedSpamRatioLowerBound',
			'userReportedSpamRatioUpperBound',
		]) {
			expect(stored[0]).not.toHaveProperty(unsupportedField);
		}
		const rows = await t.query(api.analytics.reputationQueries.getDeliveryDomainTable, {});
		expect(rows.find((row) => row.domain === 'verified.example')?.googlePostmaster).toMatchObject({
			userReportedSpamRatio: 0.002,
		});
	});

	it('refuses malformed, future, and stale provider observations', async () => {
		const t = convexTest(schema, modules);
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
		const base = {
			domain: 'verified.example',
			userReportedSpamRatio: 0.1,
			fetchedAt: now,
		};
		for (const observation of [
			{ ...base, date: 'not-a-date' },
			{ ...base, date: dateDaysAgo(-2) },
			{ ...base, date: dateDaysAgo(20) },
			{ ...base, date: dateDaysAgo(1), userReportedSpamRatio: 1.1 },
			{ ...base, date: dateDaysAgo(1), fetchedAt: now + 10 * 60_000 },
		]) {
			await expect(
				t.mutation(internal.delivery.postmaster.ingest, observation)
			).resolves.toMatchObject({ ingested: false, reason: 'invalid_observation' });
		}
	});

	it('cascades provider telemetry before deleting one domain', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const domainId = await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'delete-me.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.run((ctx) =>
			ctx.db.insert('googlePostmasterStats', {
				domainId,
				domain: 'delete-me.example',
				periodStart: now - 86_400_000,
				userReportedSpamRatio: 0.001,
				fetchedAt: now,
				ingestedAt: now,
			})
		);

		await t.mutation(internal.domains.lifecycle.remove, { domainId, userId: 'user-1' });

		expect(await t.run((ctx) => ctx.db.query('googlePostmasterStats').collect())).toHaveLength(0);
		await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'delete-me.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: now + 1,
				updatedAt: now + 1,
			})
		);
		const rows = await t.query(api.analytics.reputationQueries.getDeliveryDomainTable, {});
		expect(rows.find((row) => row.domain === 'delete-me.example')?.googlePostmaster).toBeNull();
	});

	it('prunes high-cardinality history in fixed self-scheduled batches', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', {
				domain: 'verified.example',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			for (let index = 0; index < POSTMASTER_CLEANUP_BATCH_SIZE + 3; index++) {
				await ctx.db.insert('googlePostmasterStats', {
					domainId,
					domain: `legacy-${index}.example`,
					periodStart: Date.now() - (100 + index) * 86_400_000,
					userReportedSpamRatio: 0.001,
					fetchedAt: Date.now(),
					ingestedAt: Date.now(),
				});
			}
		});

		const first = await t.mutation(internal.delivery.postmaster.cleanup, {});
		expect(first).toEqual({
			deleted: POSTMASTER_CLEANUP_BATCH_SIZE,
			continuationScheduled: true,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await t.run((ctx) => ctx.db.query('googlePostmasterStats').collect())).toHaveLength(0);
	});
});
