import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';

const resolveMtaRoutingDecision = vi.fn();
vi.mock('../../lib/sendProviders/mta', () => ({ resolveMtaRoutingDecision }));

const { resolveLastMileRouting } = await import('../lastMileRouting');

function context(...results: unknown[]): ActionCtx {
	return {
		runQuery: vi.fn(async () => results.shift()),
	} as unknown as ActionCtx;
}

const input = {
	messageType: 'campaign' as const,
	to: 'person@gmail.com',
	from: 'sender@example.org',
	organizationId: 'org-1',
	idempotencyKey: 'send-1',
	workAttemptId: 'work-1',
	routingReentryToken: 'reentry-1',
	startedAt: Date.now(),
	deliveryDomain: 'production' as const,
};

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('last-mile governance boundary', () => {
	it.each(['ses', 'resend', 'smtp'] as const)(
		'preserves an external-only %s deployment without MTA credentials',
		async (providerType) => {
			const route = { providerType, source: 'org_config' as const };
			const result = await resolveLastMileRouting(
				context({ route, baseRoute: route, isMtaGoverned: false }, 'org-1'),
				input
			);
			expect(result).toMatchObject({ kind: 'ready', providerKind: providerType, route });
			expect(resolveMtaRoutingDecision).not.toHaveBeenCalled();
		}
	);

	it.each(['ip_quarantined', 'dnsbl_listed', 'persistent_defers'] as const)(
		'keeps Convex %s fallback authoritative without suppressing it via a base-only route',
		async (deliverabilityReason) => {
			const route = {
				providerType: 'ses' as const,
				source: 'deliverability_fallback' as const,
				deliverabilityReason,
			};
			const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };
			const result = await resolveLastMileRouting(
				context({ route, baseRoute, isMtaGoverned: true }, 'org-1'),
				input
			);
			expect(result).toMatchObject({ kind: 'ready', providerKind: 'ses', route });
			expect(resolveMtaRoutingDecision).not.toHaveBeenCalled();
		}
	);

	it('still lets an MTA half-open recovery probe override a breaker snapshot', async () => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'key');
		resolveMtaRoutingDecision.mockResolvedValue({ kind: 'mta', leaseToken: 'lease-1' });
		const route = {
			providerType: 'ses' as const,
			source: 'deliverability_fallback' as const,
			deliverabilityReason: 'breaker_open' as const,
		};
		const baseRoute = {
			providerType: 'mta' as const,
			ipPool: 'campaign' as const,
			source: 'org_config' as const,
		};
		const result = await resolveLastMileRouting(
			context({ route, baseRoute, isMtaGoverned: true }, 'org-1'),
			input
		);
		expect(result).toMatchObject({
			kind: 'ready',
			providerKind: 'mta',
			route: baseRoute,
			routingLease: 'lease-1',
		});
		expect(resolveMtaRoutingDecision).toHaveBeenCalledOnce();
	});
});
