import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

async function stateFor(
	t: TestConvex<typeof schema>,
	organizationId: string,
	destinationProvider: 'gmail' | 'microsoft'
) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', organizationId).eq('destinationProvider', destinationProvider)
			)
			.first()
	);
}

describe('deliverability routing hysteresis', () => {
	it('activates one provider immediately and fails back only after healthy period plus cooldown', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 1,
			appliedAt: 1,
			signals: [
				{
					provider: 'gmail',
					source: 'breaker_open',
					severity: 'critical',
					observedAt: 1,
				},
			],
		});
		expect(await stateFor(t, 'org-a', 'gmail')).toMatchObject({
			isFallbackActive: true,
			signals: [{ source: 'breaker_open' }],
		});
		expect(await stateFor(t, 'org-a', 'microsoft')).toMatchObject({ isFallbackActive: false });

		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 2,
			appliedAt: 16 * 60 * 1000,
			signals: [],
		});
		expect(await stateFor(t, 'org-a', 'gmail')).toMatchObject({ isFallbackActive: true });

		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 3,
			appliedAt: 32 * 60 * 1000,
			signals: [],
		});
		expect(await stateFor(t, 'org-a', 'gmail')).toMatchObject({
			isFallbackActive: false,
			signals: [],
		});
	});

	it('ignores older retries and keeps tenants isolated', async () => {
		const t = convexTest(schema, modules);
		for (const organizationId of ['org-a', 'org-b']) {
			await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
				organizationId,
				generatedAt: 10,
				appliedAt: 10,
				signals:
					organizationId === 'org-a'
						? [{ provider: 'gmail', source: 'dnsbl_listed', severity: 'critical', observedAt: 10 }]
						: [],
			});
		}
		await t.mutation(internal.delivery.deliverabilityRouting.applySnapshot, {
			organizationId: 'org-a',
			generatedAt: 9,
			appliedAt: 20,
			signals: [],
		});
		expect(await stateFor(t, 'org-a', 'gmail')).toMatchObject({ isFallbackActive: true });
		expect(await stateFor(t, 'org-b', 'gmail')).toMatchObject({ isFallbackActive: false });
	});

	it('keeps the newest tenant-scoped MX classification', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'User@Workspace.Example',
				status: 'delivered',
				providerType: 'mta',
				providerMessageId: 'mta-new',
			});
		});
		await t.mutation(internal.delivery.deliverabilityRouting.recordDestinationProviderDomain, {
			providerMessageId: 'mta-new',
			destinationProvider: 'gmail',
			observedAt: now,
		});
		await t.mutation(internal.delivery.deliverabilityRouting.recordDestinationProviderDomain, {
			providerMessageId: 'mta-new',
			destinationProvider: 'microsoft',
			observedAt: now - 1,
		});

		const rows = await t.run(async (ctx) => ctx.db.query('destinationProviderDomains').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			organizationId: 'org-a',
			domain: 'workspace.example',
			destinationProvider: 'gmail',
			observedAt: now,
		});
	});

	it('rejects future, non-MTA, and unresolvable Postbox observations', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'user@example.com',
				status: 'delivered',
				providerType: 'ses',
				providerMessageId: 'ses-message',
			});
		});

		for (const input of [
			{ providerMessageId: 'ses-message', observedAt: now },
			{ providerMessageId: 'postbox-message', observedAt: now },
			{ providerMessageId: 'ses-message', observedAt: now + 2 * 60 * 1000 + 1 },
		]) {
			expect(
				await t.mutation(internal.delivery.deliverabilityRouting.recordDestinationProviderDomain, {
					...input,
					destinationProvider: 'gmail',
				})
			).toEqual({ recorded: false });
		}

		const rows = await t.run(async (ctx) => ctx.db.query('destinationProviderDomains').collect());
		expect(rows).toHaveLength(0);
	});

	it('cleans independent tables in bounded batches without starvation', async () => {
		const t = convexTest(schema, modules);
		const expiredAt = Date.now() - 1;
		await t.run(async (ctx) => {
			for (let i = 0; i < 140; i++) {
				await ctx.db.insert('deliverabilityRouteStates', {
					organizationId: `org-${i}`,
					destinationProvider: 'gmail',
					isFallbackActive: false,
					signals: [],
					snapshotGeneratedAt: i,
					expiresAt: expiredAt,
					updatedAt: expiredAt,
				});
				await ctx.db.insert('destinationProviderDomains', {
					organizationId: `org-${i}`,
					domain: `domain-${i}.example`,
					destinationProvider: 'gmail',
					observedAt: expiredAt - 1,
					expiresAt: expiredAt,
				});
			}
		});

		expect(await t.mutation(internal.delivery.deliverabilityRouting.cleanupExpired, {})).toEqual({
			deleted: 256,
			hasMore: true,
		});
		const scheduled = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]!.scheduledTime).toBeGreaterThan(Date.now());
		expect(scheduled[0]!.args[0]).toEqual({ continuation: 1 });
		expect(
			await t.run(async (ctx) => ({
				states: (await ctx.db.query('deliverabilityRouteStates').collect()).length,
				domains: (await ctx.db.query('destinationProviderDomains').collect()).length,
			}))
		).toEqual({ states: 12, domains: 12 });

		expect(await t.mutation(internal.delivery.deliverabilityRouting.cleanupExpired, {})).toEqual({
			deleted: 24,
			hasMore: false,
		});
	});

	it('hands remaining cleanup back to the cron after the bounded continuation budget', async () => {
		const t = convexTest(schema, modules);
		const expiredAt = Date.now() - 1;
		await t.run(async (ctx) => {
			for (let i = 0; i < 128; i++) {
				await ctx.db.insert('deliverabilityRouteStates', {
					organizationId: `budget-org-${i}`,
					destinationProvider: 'gmail',
					isFallbackActive: false,
					signals: [],
					snapshotGeneratedAt: i,
					expiresAt: expiredAt,
					updatedAt: expiredAt,
				});
			}
		});

		expect(
			await t.mutation(internal.delivery.deliverabilityRouting.cleanupExpired, {
				continuation: 15,
			})
		).toEqual({ deleted: 128, hasMore: true });
		expect(
			await t.run(async (ctx) => ctx.db.system.query('_scheduled_functions').collect())
		).toHaveLength(0);
	});
});
