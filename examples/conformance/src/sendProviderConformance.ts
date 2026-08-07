/**
 * THE SEND-PROVIDER CONFORMANCE BODY — what the host requires of a bundled
 * transport, written once and run against every subject that claims to be one.
 *
 * Two suites in this package drive it: `pluginProviderParity.test.ts` over the
 * hand-written Mock ESP (P3.3 — "can a package be a provider?") and
 * `scaffoldedProviderConformance.test.ts` over `owlat plugins create --template
 * send-provider`'s real output (P3.4 — "is the package we HAND an author already
 * one?"). Both questions are answered against the SAME rules, because they are
 * the host's rules and not either fixture's; a second copy of them would be a
 * second place to edit when `resolveRoute` grows an argument or
 * `DeliverabilityRouteError` is replaced, and a copy that is only edited in one
 * place silently stops measuring what it claims to. P5.3's real Postmark bundle
 * would have made it three.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT. A case belongs here when it asserts
 * something the HOST decides — routability under every declared strategy, the
 * fallback arm's per-domain proof gate, arm attribution, the return-path fold,
 * the feedback route's registration and re-validation, the derived domain status,
 * the credential vocabulary. A case stays in its own suite when it asserts
 * something the SUBJECT decides: a fixture's recorded attempt log, its wire
 * shapes' exact values, the generator's byte-for-byte output, or a binding to a
 * copy of the fixture that lives in another package.
 *
 * EVERY SUBJECT-SPECIFIC VALUE IS READ OFF THE COMPOSED ARTIFACT, never spelled:
 * the kind, the variable names, the signature contract, the credential fields.
 * A subject that renames any of them is still measured against what it now
 * declares.
 */

import { createHmac } from 'node:crypto';
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
import { pluginSendTransportWebhookFor } from '@owlat/api/plugins/sendTransportWebhookCatalog';
import { pluginSendTransportDomainIdentityFor } from '@owlat/api/plugins/sendTransportDomainIdentityCatalog';
import { verifyPluginReplayBoundSignature } from '@owlat/api/plugins/inboundSignature';
import { parsePluginFeedbackEvents } from '@owlat/api/webhooks/pluginFeedbackEvents';
import { parsePluginRelayResult } from '@owlat/api/domains/pluginRelayState';
import {
	OWN_SEND_PROVIDER_KIND,
	SEND_PROVIDER_CREDENTIAL_FIELD_KINDS,
} from '@owlat/shared/sendProviderCatalog';

/** The webhook signature contract, as the composed webhook catalog carries it. */
export interface ConformanceSignatureContract {
	readonly header: string;
	readonly algorithm: string;
	readonly encoding: string;
	readonly secretEnvVar: string;
	readonly replay: { readonly timestampHeader: string; readonly toleranceSeconds: number };
}

/**
 * One arranged call into the subject's identity module.
 *
 * The subjects make their module answer in completely different ways — the Mock
 * ESP keys its answers off the domain name, the scaffolded bundle stubs `fetch` —
 * so a scenario is a THUNK: it performs whatever arrangement it needs and returns
 * the arguments to call with. That is the only part of the identity block that is
 * genuinely the subject's, and it is the only part the subject supplies.
 */
export interface ConformanceDomainScenario {
	readonly domain: string;
	readonly config: { readonly instanceKey: string | null; readonly env: Record<string, string> };
}

export interface SendProviderConformanceSubject {
	/** The composed transport kind, as the catalog serves it. */
	readonly kind: SendProviderKind;
	/** The plugin id the feedback route is keyed by. */
	readonly pluginId: string;
	/** The composed catalog entry, as a plain record. */
	readonly entry: Record<string, unknown>;
	/** The transport contribution's own configuration — what ONE instance needs. */
	readonly instanceRequiredEnv: readonly string[];
	readonly instanceOptionalEnv: readonly string[];
	/** The plugin's deployment-wide gate, read unsuffixed. */
	readonly flagRequiredEnv: readonly string[];
	/** The signature contract the composed webhook registration carries. */
	readonly signature: ConformanceSignatureContract;
	/** The value a deployment would set the signing secret to. */
	readonly webhookSecretValue: string;
	/**
	 * One signed batch in the subject's own wire shape, and the feedback facts the
	 * host must end up with. Written by the subject because the shape is its
	 * provider's; asserted here because the CHAIN is the host's.
	 */
	readonly feedbackBatch: { readonly body: string; readonly kinds: readonly string[] };
	/** How to make the identity module answer each of the three ways that matter. */
	readonly domainScenarios: {
		readonly verified: () => ConformanceDomainScenario;
		readonly unverified: () => ConformanceDomainScenario;
		readonly authFailed: () => ConformanceDomainScenario;
	};
}

/** Every strategy the registry declares, derived — never a list of four names. */
const CONTEXT_FREE_STRATEGIES = Object.keys(SEND_ROUTE_STRATEGIES).filter(
	(strategy) => strategy !== 'adaptive_mix'
) as readonly ProviderRouteConfig['strategy'][];

/**
 * Every host-decided property of a bundled send transport, asserted against one
 * subject. Call it from a suite that has already mocked the generated catalogs
 * with that subject's composition.
 */
export function describeSendProviderConformance(subject: SendProviderConformanceSubject): void {
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

	describe('its feedback arrives on the plugin webhook route', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		// The route is keyed by PLUGIN ID and resolves before a byte of the body is
		// read; an unknown id is the 404 that keeps unverified traffic away from
		// signature verification entirely.
		it('registers exactly this plugin id, and nothing else', () => {
			expect(pluginSendTransportWebhookFor(subject.pluginId)?.definition).toMatchObject({
				kind: KIND,
				pluginId: subject.pluginId,
				storeRawPayload: false,
			});
			expect(pluginSendTransportWebhookFor('someone-else')).toBeUndefined();
			// Map-backed, so a prototype key resolves to nothing rather than to an
			// inherited member being called as an adapter.
			expect(pluginSendTransportWebhookFor('__proto__')).toBeUndefined();
		});

		/**
		 * THE REPLAY PROVISIONS THE HOST REQUIRES, carried from the manifest through
		 * codegen. A bundle that shipped a body-only HMAC would fail validation; one
		 * that shipped an unbounded tolerance would expose an endpoint a captured
		 * request verifies against forever.
		 */
		it('carries a bounded, replay-bound signature contract', () => {
			expect(subject.signature.algorithm).toBe('hmac-sha256');
			expect(subject.signature.replay.timestampHeader.length).toBeGreaterThan(0);
			expect(subject.signature.replay.toleranceSeconds).toBeGreaterThan(0);
			expect(subject.signature.replay.toleranceSeconds).toBeLessThanOrEqual(900);
		});

		/**
		 * THE WHOLE CHAIN, and THROUGH THE LOOKUP rather than through the module: the
		 * host proves authenticity, the bundle's module turns verified bytes into
		 * feedback facts, and the host re-validates that output and stamps the
		 * transport kind ITSELF — so a plugin cannot attribute a bounce to somebody
		 * else's arm. Calling the module directly would leave a registry that
		 * answered this plugin id with SOMEBODY ELSE's parser perfectly green, which
		 * is the one join this case exists to prove.
		 *
		 * The verifier's negatives — tampered body, forged signature, stale
		 * timestamp, unset secret — are `verifyPluginReplayBoundSignature`'s own
		 * contract and are owned exhaustively by
		 * `apps/api/convex/plugins/__tests__/inboundSignature.test.ts` and
		 * `apps/api/convex/webhooks/__tests__/pluginFeedbackRoute.test.ts`. A third
		 * copy would add no case and one more place to edit.
		 */
		it('verifies, parses and revalidates a signed batch into feedback facts', async () => {
			vi.stubEnv(subject.signature.secretEnvVar, subject.webhookSecretValue);
			const surface = pluginSendTransportWebhookFor(subject.pluginId);
			if (!surface) throw new Error('the subject webhook is not registered');

			const nowMs = Date.now();
			const timestamp = String(Math.floor(nowMs / 1000));
			const body = subject.feedbackBatch.body;
			const verified = await verifyPluginReplayBoundSignature({
				contract: surface.definition.signature,
				pluginId: subject.pluginId,
				transportKind: KIND,
				rawBody: body,
				signature: createHmac('sha256', subject.webhookSecretValue)
					.update(`${timestamp}.${body}`)
					.digest('hex'),
				timestamp,
				nowMs,
			});
			expect(verified.ok).toBe(true);

			// The kind is taken from the RESOLVED REGISTRATION, not from a constant:
			// passing the kind here would reduce the assertion below to "the function
			// stamps what I gave it".
			const events = parsePluginFeedbackEvents(
				surface.module.parseEvents(body),
				surface.definition.kind
			);
			expect(events.map((event) => event.kind)).toEqual(subject.feedbackBatch.kinds);
			expect(
				events.every(
					(event) =>
						'providerType' in event &&
						(event as { readonly providerType?: string }).providerType === KIND
				)
			).toBe(true);
		});
	});

	describe('it proves a sending domain through its identity module', () => {
		/**
		 * THE MODULE THE HOST WOULD CALL, resolved the way the host resolves it — by
		 * NAMESPACED KIND, which is how this registry is keyed (the feedback one is
		 * keyed by plugin id, because its route surface is). Calling an imported
		 * fixture object directly would leave a registry that keyed identities by
		 * `pluginId` perfectly green while the host asked the wrong third party
		 * whether this domain is proven.
		 */
		function identityModule() {
			const surface = pluginSendTransportDomainIdentityFor(KIND);
			if (!surface) throw new Error('the subject domain identity is not registered');
			return surface.module;
		}

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('is registered as a sending-domain identity provider for its own kind', () => {
			expect(pluginSendTransportDomainIdentityFor(KIND)?.definition).toMatchObject({
				kind: KIND,
				pluginId: subject.pluginId,
				requiredEnvVars: subject.instanceRequiredEnv,
			});
		});

		// THE SPLIT: the module reports observations, the HOST derives the status.
		it('derives verified from the observations the module reported', async () => {
			const scenario = subject.domainScenarios.verified();
			const outcome = parsePluginRelayResult(
				await identityModule().registerDomain(scenario.domain, scenario.config)
			);
			expect(outcome.outcome).toBe('ok');
			expect(outcome.outcome === 'ok' ? outcome.observation.status : null).toBe('verified');
			// A selector list is what the ramp's alignment pre-flight resolves; an
			// empty one holds every domain at s=0, so a bundle must ship a real one.
			expect(
				outcome.outcome === 'ok' ? outcome.observation.dkimSelectors.length : 0
			).toBeGreaterThan(0);
		});

		it('reports a domain whose proof is incomplete as anything but verified', async () => {
			const scenario = subject.domainScenarios.unverified();
			const outcome = parsePluginRelayResult(
				await identityModule().checkDomain(scenario.domain, scenario.config)
			);
			expect(outcome.outcome === 'ok' ? outcome.observation.status : null).not.toBe('verified');
		});

		// A credential the provider rejected is TERMINAL and says so — distinguishable
		// from an outage, because the host's write rules differ: only this one
		// condemns a credential, and neither refreshes the proof's age.
		it('reports a rejected credential as auth_failed, not as an outage', async () => {
			const scenario = subject.domainScenarios.authFailed();
			expect(
				parsePluginRelayResult(await identityModule().checkDomain(scenario.domain, scenario.config))
					.outcome
			).toBe('auth_failed');
		});

		// Untrusted output is untrusted output: a shape the host does not recognise is
		// `unavailable` — evidence of nothing — never a verdict that could mark a
		// domain unverified while refreshing the freshness clock.
		it('reads a malformed module answer as unavailable', () => {
			expect(parsePluginRelayResult({ outcome: 'ok' }).outcome).toBe('unavailable');
		});
	});

	describe('its credential form is one the shared UI vocabulary can draw', () => {
		const fields = entry['credentialFields'] as readonly Record<string, unknown>[];

		it('declares its form in the shared field vocabulary', () => {
			expect(fields.length).toBeGreaterThan(0);
			for (const field of fields) {
				expect(SEND_PROVIDER_CREDENTIAL_FIELD_KINDS).toContain(field['kind']);
			}
		});

		/**
		 * THE JOIN THAT MAKES A FORM HONEST: every variable the form writes is one
		 * the transport reads, in the list matching the field's own `required`. A
		 * form asking for a variable no send reads is an operator filling in nothing;
		 * one omitting a gating variable is a transport that stays unconfigured
		 * behind a complete-looking form.
		 */
		it('asks only for variables this transport reads, in the matching list', () => {
			const required = new Set(subject.instanceRequiredEnv);
			const optional = new Set(subject.instanceOptionalEnv);
			for (const field of fields) {
				const envVar = field['envVar'] as string;
				expect(field['required'] === true ? required.has(envVar) : optional.has(envVar)).toBe(true);
			}
			// Every required variable is askable, or an operator cannot configure the
			// transport from the form at all.
			for (const name of subject.instanceRequiredEnv) {
				expect(fields.some((field) => field['envVar'] === name)).toBe(true);
			}
		});

		// The renderer keys its form state by ENV VARIABLE and never renders a
		// `secret` back, so the descriptor is what tells a surface which value is
		// write-only.
		it('marks the credential itself write-only', () => {
			const secret = fields.find((field) => field['envVar'] === subject.instanceRequiredEnv[0]);
			expect(secret).toMatchObject({ kind: 'secret', required: true });
		});
	});
}
