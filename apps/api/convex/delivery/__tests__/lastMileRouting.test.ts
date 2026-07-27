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
		resolveMtaRoutingDecision.mockResolvedValue({
			kind: 'mta',
			leaseToken: 'lease-1',
			isProviderProbe: true,
			isGlobalProbe: false,
		});
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
		expect(resolveMtaRoutingDecision).toHaveBeenCalledWith(
			// The lease is taken from the transport the send will go through.
			expect.objectContaining({ id: 'mta', kind: 'mta', instanceKey: null }),
			expect.objectContaining({ requireProviderProbe: true })
		);
	});

	it.each([
		{ isProviderProbe: false, isGlobalProbe: false, label: 'normal MTA route' },
		{ isProviderProbe: false, isGlobalProbe: true, label: 'unrelated global probe' },
	])('preserves relay hysteresis for a $label', async (decision) => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'key');
		resolveMtaRoutingDecision.mockResolvedValue({
			kind: 'mta',
			leaseToken: 'lease-unused',
			isProviderProbe: decision.isProviderProbe,
			isGlobalProbe: decision.isGlobalProbe,
		});
		const route = {
			providerType: 'ses' as const,
			source: 'deliverability_fallback' as const,
			deliverabilityReason: 'breaker_open' as const,
		};
		const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };
		expect(
			await resolveLastMileRouting(
				context({ route, baseRoute, isMtaGoverned: true }, 'org-1'),
				input
			)
		).toMatchObject({ kind: 'ready', providerKind: 'ses', route });
	});

	it('marks a safety refusal as a hold rather than ordinary routing churn', async () => {
		expect(
			await resolveLastMileRouting(
				context(
					{
						route: null,
						baseRoute: null,
						isMtaGoverned: true,
						deferralCode: 'GLOBAL_DELIVERY_CIRCUIT_OPEN',
					},
					'org-1'
				),
				input
			)
		).toMatchObject({ kind: 'defer', isPolicyHold: true });
	});

	// Every `kind: 'ready'` return has to carry the relay return-path verdict:
	// `governedDispatch` reads it straight off the routing result, so a branch
	// that forgets it silently sends without our VERP envelope sender and the
	// relay arm's bounces become invisible (plan G-08).
	describe('the relay return-path verdict survives every ready route', () => {
		it('carries it on an external-only relay route', async () => {
			const route = { providerType: 'smtp' as const, source: 'org_config' as const };
			expect(
				await resolveLastMileRouting(
					context(
						{
							route,
							baseRoute: route,
							isMtaGoverned: false,
							relayReturnPathHost: 'bounces.example.com',
						},
						'org-1'
					),
					input
				)
			).toMatchObject({
				kind: 'ready',
				providerKind: 'smtp',
				relayReturnPathHost: 'bounces.example.com',
			});
		});

		it('carries it on a Convex deliverability-fallback route', async () => {
			const route = {
				providerType: 'smtp' as const,
				source: 'deliverability_fallback' as const,
				deliverabilityReason: 'dnsbl_listed' as const,
			};
			const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };
			expect(
				await resolveLastMileRouting(
					context(
						{ route, baseRoute, isMtaGoverned: true, relayReturnPathHost: 'bounces.example.com' },
						'org-1'
					),
					input
				)
			).toMatchObject({
				kind: 'ready',
				providerKind: 'smtp',
				relayReturnPathHost: 'bounces.example.com',
			});
		});

		// THE route that carries most relay traffic during a ramp: the MTA
		// declines the message for warm-up overflow (or an open breaker) and the
		// relay absorbs it. It is resolved AFTER the routing plan, which is
		// exactly why it was the branch that lost the flag.
		it.each(['warmup_overflow', 'breaker_open'] as const)(
			'carries it on the %s relay fallback the MTA hands off to',
			async (reason) => {
				vi.stubEnv('MTA_API_URL', 'https://mta.test');
				vi.stubEnv('MTA_API_KEY', 'key');
				resolveMtaRoutingDecision.mockResolvedValue({ kind: 'relay', reason });
				const baseRoute = {
					providerType: 'mta' as const,
					source: 'org_config' as const,
					warmupOverflowEnabled: true,
				};
				const relayRoute = { providerType: 'smtp' as const, source: 'org_config' as const };
				const result = await resolveLastMileRouting(
					context(
						{
							route: baseRoute,
							baseRoute,
							isMtaGoverned: true,
							relayReturnPathHost: 'bounces.example.com',
						},
						{ route: relayRoute }
					),
					input
				);
				expect(result).toMatchObject({
					kind: 'ready',
					providerKind: 'smtp',
					route: relayRoute,
					relayReturnPathHost: 'bounces.example.com',
				});
			}
		);

		// D2: an unproven / unprobed / absent relay is a SUPPORTED configuration.
		// The overflow route still sends — it just does not stamp.
		it('carries an unproven verdict through the overflow fallback without blocking', async () => {
			vi.stubEnv('MTA_API_URL', 'https://mta.test');
			vi.stubEnv('MTA_API_KEY', 'key');
			resolveMtaRoutingDecision.mockResolvedValue({ kind: 'relay', reason: 'warmup_overflow' });
			const baseRoute = {
				providerType: 'mta' as const,
				source: 'org_config' as const,
				warmupOverflowEnabled: true,
			};
			const relayRoute = { providerType: 'smtp' as const, source: 'org_config' as const };
			expect(
				await resolveLastMileRouting(
					context(
						{
							route: baseRoute,
							baseRoute,
							isMtaGoverned: true,
							relayReturnPathHost: undefined,
						},
						{ route: relayRoute }
					),
					input
				)
			).toMatchObject({
				kind: 'ready',
				providerKind: 'smtp',
				relayReturnPathHost: undefined,
			});
		});
	});

	// An acceptance-unknown retry may be racing an MTA job that was actually
	// committed. Only the owned-MTA path deduplicates it (on the reused
	// workAttemptId); a relay carries no idempotency key at all, so relaying
	// here delivers a second copy to the recipient.
	describe('acceptance reconciliation never leaves the owned MTA path', () => {
		const reconciling = { ...input, mtaReconciliation: true };

		it.each(['ses', 'resend', 'smtp'] as const)(
			'defers an external-only %s deployment',
			async (providerType) => {
				const route = { providerType, source: 'org_config' as const };
				expect(
					await resolveLastMileRouting(
						context({ route, baseRoute: route, isMtaGoverned: false }, 'org-1'),
						reconciling
					)
				).toMatchObject({ kind: 'defer' });
			}
		);

		it.each(['ip_quarantined', 'dnsbl_listed', 'persistent_defers'] as const)(
			'defers a Convex %s snapshot fallback instead of relaying',
			async (deliverabilityReason) => {
				const route = {
					providerType: 'ses' as const,
					source: 'deliverability_fallback' as const,
					deliverabilityReason,
				};
				const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };
				expect(
					await resolveLastMileRouting(
						context({ route, baseRoute, isMtaGoverned: true }, 'org-1'),
						reconciling
					)
				).toMatchObject({ kind: 'defer' });
				expect(resolveMtaRoutingDecision).not.toHaveBeenCalled();
			}
		);

		it('defers relay hysteresis on an open breaker instead of relaying', async () => {
			vi.stubEnv('MTA_API_URL', 'https://mta.test');
			vi.stubEnv('MTA_API_KEY', 'key');
			resolveMtaRoutingDecision.mockResolvedValue({
				kind: 'mta',
				leaseToken: 'lease-unused',
				isProviderProbe: false,
				isGlobalProbe: false,
			});
			const route = {
				providerType: 'ses' as const,
				source: 'deliverability_fallback' as const,
				deliverabilityReason: 'breaker_open' as const,
			};
			const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };
			expect(
				await resolveLastMileRouting(
					context({ route, baseRoute, isMtaGoverned: true }, 'org-1'),
					reconciling
				)
			).toMatchObject({ kind: 'defer' });
		});

		it('still allows the owned MTA route that can deduplicate the attempt', async () => {
			vi.stubEnv('MTA_API_URL', 'https://mta.test');
			vi.stubEnv('MTA_API_KEY', 'key');
			resolveMtaRoutingDecision.mockResolvedValue({
				kind: 'mta',
				leaseToken: 'lease-1',
				isProviderProbe: false,
				isGlobalProbe: false,
			});
			const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };
			expect(
				await resolveLastMileRouting(
					context({ route: baseRoute, baseRoute, isMtaGoverned: true }, 'org-1'),
					reconciling
				)
			).toMatchObject({ kind: 'ready', providerKind: 'mta', routingLease: 'lease-1' });
		});
	});
});
