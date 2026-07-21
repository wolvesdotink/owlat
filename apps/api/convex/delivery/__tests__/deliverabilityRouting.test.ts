import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
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
		await t.mutation(internal.delivery.deliverabilityRouting.recordDestinationProviderDomain, {
			organizationId: 'org-a',
			recipient: 'User@Workspace.Example',
			destinationProvider: 'gmail',
			observedAt: 20,
		});
		await t.mutation(internal.delivery.deliverabilityRouting.recordDestinationProviderDomain, {
			organizationId: 'org-a',
			recipient: 'other@workspace.example',
			destinationProvider: 'microsoft',
			observedAt: 10,
		});

		const rows = await t.run(async (ctx) => ctx.db.query('destinationProviderDomains').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			organizationId: 'org-a',
			domain: 'workspace.example',
			destinationProvider: 'gmail',
			observedAt: 20,
		});
	});
});
