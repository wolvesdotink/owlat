import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// Pass the org-member floor and the admin gate. requireAdminContext is mocked
// directly because, within sessionOrganization.ts, it calls the real (intra-
// module) getMutationContext — so mocking only the leaf helpers at the module
// boundary doesn't reach it. (Same approach as domainsGating.integration.test.)
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi
			.fn()
			.mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

async function insertTrackingDomain(
	t: ReturnType<typeof convexTest>,
	domain = 'track.example.com',
): Promise<Id<'trackingDomains'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('trackingDomains', {
			domain,
			cnameTarget: 'track.owlat.com',
			isVerified: false,
			verifiedAt: undefined,
			createdAt: Date.now(),
		}),
	);
}

describe('domains.trackingDomains', () => {
	beforeEach(() => {
		// The verify mutation schedules a DNS-over-HTTPS lookup; stub fetch so the
		// scheduled action resolves without touching the network.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ Answer: [] }),
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('verifyTrackingDomain', () => {
		it('returns a truthy success sentinel so the FE can distinguish success from a caught failure', async () => {
			const t = convexTest(schema, modules);
			const id = await insertTrackingDomain(t);

			// This return value is load-bearing: the Operation module's run()
			// resolves to `undefined` on a caught error, so the FE keys its success
			// UX (auto-expand row + "Checking DNS…" toast) off `result !== undefined`.
			const result = await t.mutation(api.domains.trackingDomains.verifyTrackingDomain, {
				trackingDomainId: id,
			});

			expect(result).toEqual({ success: true });
			expect(result).not.toBeUndefined();

			await new Promise((resolve) => setTimeout(resolve, 0));
			await t.finishInProgressScheduledFunctions();
		});

		it('throws (not undefined-returns) for an unknown tracking domain', async () => {
			const t = convexTest(schema, modules);

			await expect(
				t.mutation(api.domains.trackingDomains.verifyTrackingDomain, {
					trackingDomainId: 'nonexistent' as Id<'trackingDomains'>,
				}),
			).rejects.toThrow();
		});
	});

	describe('removeTrackingDomain', () => {
		it('deletes the domain and returns a truthy success sentinel', async () => {
			const t = convexTest(schema, modules);
			const id = await insertTrackingDomain(t, 'track-delete.example.com');

			// Sentinel lets the FE reach close-modal + success-toast (run() yields
			// `undefined` on error, so a void return would look like a failure).
			const result = await t.mutation(api.domains.trackingDomains.removeTrackingDomain, {
				trackingDomainId: id,
			});

			expect(result).toEqual({ success: true });
			expect(result).not.toBeUndefined();

			await t.run(async (ctx) => {
				expect(await ctx.db.get(id)).toBeNull();
			});
		});
	});
});
