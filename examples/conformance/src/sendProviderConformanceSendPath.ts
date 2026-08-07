/**
 * THE SEND PATH, as the host decides it — half of the send-provider conformance
 * body (see `./sendProviderConformance` for what the body is and who runs it).
 *
 * Everything a message passes through on its way out, up to the moment a module
 * is called: the composed catalog entry a route resolves against, routability
 * under every declared strategy, the deliverability fallback arm and its
 * per-domain proof gate, arm attribution and the return-path fold. The call
 * itself — instance resolution, the grant recheck and the two fail-closed
 * refusals — is `./sendProviderConformanceDispatch`, and what comes back is
 * `./sendProviderConformanceFeedback`.
 *
 * Three modules rather than one because one had passed the repository's ~500 LOC
 * guideline, and along the seam a reader already has in their head: where a
 * message goes, how it is handed over, and what comes back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	isProbeDecidedReturnPathKind,
	isSendProviderKind,
	sendProviderCatalogEntry,
	type SendProviderKind,
} from '@owlat/api/sendProviders/catalog';
import {
	DeliverabilityRouteError,
	resolveRoute,
	type ProviderRouteConfig,
} from '@owlat/api/sendProviders/routing';
import { SEND_ROUTE_STRATEGIES } from '@owlat/api/sendProviders/strategies';
import {
	isFallbackRelayEligible,
	routeCarriesEnabledRelay,
} from '@owlat/api/sendProviders/fallbackEligibility';
import {
	BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK,
	BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK,
	measurementQualityOf,
	resolveReturnPathCapability,
	widenBounceTolerance,
} from '@owlat/api/sendProviders/returnPathCapability';
import { armForTransport } from '@owlat/api/delivery/sendAssignments';
import { OWN_SEND_PROVIDER_KIND } from '@owlat/shared/sendProviderCatalog';
import type { SendProviderConformanceSubject } from './sendProviderConformanceSubject';

/** Every strategy the registry declares, derived — never a list of four names. */
const CONTEXT_FREE_STRATEGIES = Object.keys(SEND_ROUTE_STRATEGIES).filter(
	(strategy) => strategy !== 'adaptive_mix'
) as readonly ProviderRouteConfig['strategy'][];

export function describeSendPathConformance(subject: SendProviderConformanceSubject): void {
	const KIND = subject.kind;
	const OWN = OWN_SEND_PROVIDER_KIND as SendProviderKind;
	const entry = subject.entry;

	/**
	 * The readiness predicate `resolveRoute` is given: env presence, as shipped.
	 * Exactly the two kinds the routes below name and no third — a predicate that
	 * answered for a kind no case routes to would read as if a mixed pool were
	 * being exercised, and would quietly change what "unroutable" means.
	 */
	const configured = (kind: SendProviderKind): boolean => kind === KIND || kind === OWN;

	function route(overrides: Partial<ProviderRouteConfig>): ProviderRouteConfig {
		return {
			strategy: 'single',
			providers: [{ providerType: KIND, isEnabled: true }],
			...overrides,
		};
	}

	describe('it composes into a first-class catalog entry', () => {
		// The join every case below stands on: the composed catalog is what
		// `sendProviderCatalogEntry` answers from, so if the subject did not land in
		// it, every "it is routable" assertion would be about a kind the catalog
		// invented.
		it('is served by the shipped catalog as the entry composition produced', () => {
			expect(isSendProviderKind(KIND)).toBe(true);
			expect(sendProviderCatalogEntry(KIND)).toEqual(entry);
		});

		/**
		 * DERIVED, not declared. The manifest says `webhook` and `domainIdentity`;
		 * the two capability words the rest of the host reads are computed from
		 * them, so a bundle cannot promise feedback it has no parser for or an
		 * identity API it never ships.
		 */
		it('derives both capability words from the halves that implement them', () => {
			expect(entry['hasProviderFeedback']).toBe(true);
			expect(entry['domainVerification']).toBe('api');
		});

		/**
		 * THE TIER BOUNDARY, asserted rather than assumed. A third-party transport
		 * may not claim envelope-sender control (the VERP local part is signed with
		 * a deployment secret it is never handed), nor custody of an in-flight
		 * message, nor an id minted before dispatch — the last two are refused at
		 * composition time, and a subject that declared them would never reach here.
		 */
		it('declares only capability values this tier may hold', () => {
			expect(entry['supportsCustomReturnPath']).toBe('no');
			expect(entry['acceptanceSemantics']).toBeUndefined();
			expect(entry['messageIdSource']).not.toBe('idempotency-key');
			// The dedup promise needs `buildSystemMailExtras` to carry the key, which
			// this tier has no way to declare.
			expect(entry['deduplicatesOnIdempotencyKey']).not.toBe(true);
		});

		it('declares a per-instance credential, which is what makes instances resolvable', () => {
			// A transport that declared none would keep working on the default
			// instance and be refused `instances_unsupported` for every named one.
			expect(subject.instanceRequiredEnv.length).toBeGreaterThan(0);
			expect(entry['instanceEnvVars']).toEqual([
				...subject.instanceRequiredEnv,
				...subject.instanceOptionalEnv,
			]);
		});

		it('folds both configuration scopes into the presence list the host asks about', () => {
			for (const name of [...subject.flagRequiredEnv, ...subject.instanceRequiredEnv]) {
				expect(
					entry['requiredEnvVars'] as readonly string[],
					`${name} is not in the composed presence list`
				).toContain(name);
			}
		});

		/**
		 * The two scopes the manifest validator refuses to let overlap: the plugin's
		 * deployment-wide gate is read unsuffixed, the transport's configuration is
		 * read per instance. A bundle that put its API key in the flag would have no
		 * per-instance credential at all.
		 */
		it('keeps the plugin gate and the transport credential in separate scopes', () => {
			expect(subject.flagRequiredEnv).toContain(subject.signature.secretEnvVar);
			for (const name of [...subject.instanceRequiredEnv, ...subject.instanceOptionalEnv]) {
				expect(subject.flagRequiredEnv, `${name} is both a gate and a credential`).not.toContain(
					name
				);
			}
		});
	});

	describe('it appears in routes, under every declared strategy', () => {
		/**
		 * THE AMBIENT ENVIRONMENT IS NOT AN INPUT TO THIS BLOCK. A route that
		 * resolves to nothing falls through to `fallback()`, which reads the
		 * deployment's `EMAIL_PROVIDER` — a real variable for this repository. A
		 * developer or CI runner with one exported would otherwise turn "the plugin
		 * is filtered out" into "the single-transport env answered instead".
		 */
		beforeEach(() => {
			vi.stubEnv('EMAIL_PROVIDER', '');
		});

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		/**
		 * Deriving the list is what makes "under ALL strategies" survive the fifth:
		 * the registry's own comment anticipates `least_loaded` / `geo_aware`, and a
		 * fifth member would otherwise land with this block green and still captioned
		 * "all four".
		 */
		it.each(CONTEXT_FREE_STRATEGIES.map((strategy) => [strategy] as const))(
			'resolves the transport under %s',
			(strategy) => {
				expect(resolveRoute(route({ strategy }), [], configured)).toMatchObject({
					providerType: KIND,
					source: 'org_config',
				});
			}
		);

		/**
		 * THE DRAW, OVER A MIXED POOL — the one strategy where a single-entry route
		 * proves nothing. `workloadSplitStrategy.select` is a weighted pick over the
		 * ENABLED pool, so with one entry it returns that entry whatever the
		 * weighting does. Deterministic by pinning the draw at each end of the range
		 * rather than by weighting, so BOTH arms are shown reachable: the strategy
		 * walks the pool in route order subtracting each weight, so the bottom of the
		 * range is the first entry and the top is the last. A filter that dropped the
		 * plugin kind would return the own MTA for both.
		 */
		it.each([
			[0, OWN],
			[0.99, KIND],
		])('draws %s of a mixed workload_split pool as %s', (draw, expected) => {
			const random = vi.spyOn(Math, 'random').mockReturnValue(draw);
			try {
				expect(
					resolveRoute(
						route({
							strategy: 'workload_split',
							providers: [
								{ providerType: OWN, isEnabled: true },
								{ providerType: KIND, isEnabled: true },
							],
						}),
						[],
						configured
					)
				).toMatchObject({ providerType: expected, source: 'org_config' });
			} finally {
				random.mockRestore();
			}
		});

		// THE MIX, and the one that matters most: `adaptive_mix` splits a cell
		// between the own MTA and a REFERENCE arm, and a bundled transport is that
		// arm on the same terms SES is. Both degenerate shares are driven so the case
		// cannot pass by the mix simply ignoring the share.
		it.each([
			[0, KIND],
			[1, OWN],
		])('sends share %s of an adaptive_mix cell to %s', (ownShare, expected) => {
			expect(
				resolveRoute(
					route({
						strategy: 'adaptive_mix',
						providers: [
							{ providerType: OWN, isEnabled: true },
							{ providerType: KIND, isEnabled: true },
						],
					}),
					[],
					configured,
					undefined,
					{ kind: 'decide', input: { cell: { ownShare }, recipient: { contactId: 'contact-1' } } }
				)
			).toMatchObject({ providerType: expected });
		});

		// A transport whose credentials are unset is not routable, whatever the row
		// says — the same fail-closed readiness filter every core kind passes through.
		it('is filtered out of the route when its credentials are unset', () => {
			expect(resolveRoute(route({}), [], (kind) => kind !== KIND)).toBeNull();
		});
	});

	describe('it is fallback-eligible, and still held to the per-domain proof gate', () => {
		function fallbackRoute(): ProviderRouteConfig {
			return route({
				providers: [
					{ providerType: OWN, isEnabled: true },
					{ providerType: KIND, isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: KIND,
					isWarmupOverflowEnabled: false,
				},
			});
		}

		// The two halves of the gate, each pinned on its own: eligibility is a
		// CAPABILITY question (is it a known transport that is not our own MTA), and
		// configured-ness is injected by the caller.
		it('may serve as the deliverability fallback relay, and fails closed unconfigured', () => {
			expect(isFallbackRelayEligible(KIND, configured)).toBe(true);
			expect(isFallbackRelayEligible(KIND, () => false)).toBe(false);
			expect(routeCarriesEnabledRelay(fallbackRoute().providers, KIND)).toBe(true);
		});

		// THE PROOF OBLIGATION: the shipped fallback arm actually hands the send to
		// the bundled transport, with the reason the route asked for.
		it('takes over a blocklisted cell from the own MTA', () => {
			expect(
				resolveRoute(fallbackRoute(), [], configured, {
					activeReasons: ['dnsbl_listed'],
					isWarmupOverflow: false,
					isRelayDomainVerified: true,
				})
			).toEqual({
				providerType: KIND,
				source: 'deliverability_fallback',
				deliverabilityReason: 'dnsbl_listed',
			});
		});

		// And it is held to the SAME per-domain proof gate a core relay is: eligible
		// is not sufficient. An unverified sending domain refuses the relay rather
		// than quietly handing a third party a From domain it cannot prove.
		it('is refused for a sending domain it has not proven', () => {
			expect(() =>
				resolveRoute(fallbackRoute(), [], configured, {
					activeReasons: ['dnsbl_listed'],
					isWarmupOverflow: false,
					isRelayDomainVerified: false,
				})
			).toThrow(DeliverabilityRouteError);
		});
	});

	describe('it is a reference arm and its return-path posture is honest', () => {
		// Attribution is decided once, at assignment time, by asking only whether the
		// transport is our own MTA. A bundled kind is `reference` for exactly the
		// reason SES is.
		it('files sends on the reference arm, and the own MTA on the own arm', () => {
			expect(armForTransport(KIND)).toBe('reference');
			expect(armForTransport(OWN)).toBe('own');
		});

		/**
		 * THE PROBE WIRE STAYS CLOSED, and the declaration is nonetheless READ.
		 *
		 * `supportsCustomReturnPath: 'no'` is the only value this tier may declare
		 * (the VERP local part a probe measures is signed with a deployment secret a
		 * third-party module is never handed), so the kind is unprobeable by
		 * construction — and the fold produces the honest posture rather than
		 * pretending the cell's bounce comparison is comparable.
		 */
		it('is never probed, and grades degraded from its declaration alone', () => {
			expect(isProbeDecidedReturnPathKind(KIND)).toBe(false);
			const resolved = resolveReturnPathCapability(KIND, null, Date.now());
			expect(resolved).toMatchObject({
				capability: 'unsupported',
				declared: 'no',
				reason: 'declared_unsupported',
				probeStatus: 'never_probed',
			});
			expect(measurementQualityOf(resolved)).toBe('degraded');
		});

		/**
		 * THE BUNDLE'S COHERENCE, visible in the controller's arithmetic: because
		 * this subject ships a feedback webhook, its bounces are real data with
		 * different coverage and the gate widens modestly — not the hard widening
		 * reserved for an arm with no feedback at all. A bundle that dropped its
		 * webhook would move this number, which is the point of asserting it.
		 */
		it('widens the bounce gate as a provider-feedback arm, not a silent one', () => {
			const resolved = resolveReturnPathCapability(KIND, null, Date.now());
			expect(resolved.bounceToleranceMultiplier).toBe(
				BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK
			);
			expect(resolved.bounceToleranceMultiplier).not.toBe(BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK);
			expect(widenBounceTolerance(0.02, resolved)).toBeCloseTo(
				0.02 * BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK
			);
		});
	});
}
