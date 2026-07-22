import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';
import schema from '../schema';
import { internal } from '../_generated/api';

const modules = import.meta.glob('../**/*.*s');

describe('SES relay proof renewal', () => {
	it('schedules one bounded page and persists a continuation beyond 100 identities', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index++) {
				const domainId = await ctx.db.insert('domains', {
					domain: `relay-${index}.example`,
					providerType: 'mta',
					status: 'verified',
					dnsRecords: {},
					createdAt: index,
					updatedAt: index,
				});
				await ctx.db.insert('sendingDomainSesIdentities', {
					domainId,
					dkimTokens: ['token'],
					verificationToken: 'proof',
					dnsRecords: {},
					isProviderVerified: true,
					verifiedAt: now - SES_RELAY_PROOF_MAX_AGE_MS,
					createdAt: index,
					updatedAt: index,
				});
			}
		});

		expect(
			await t.mutation(internal.domains.sesRelayMutations.scheduleVerificationRefresh, {})
		).toBe(100);
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(scheduled).toHaveLength(101);
		expect(scheduled.filter((job) => typeof job.args[0]?.cursor === 'string')).toHaveLength(1);
		expect(scheduled.filter((job) => job.args[0]?.domainId !== undefined)).toHaveLength(100);
	});
});
