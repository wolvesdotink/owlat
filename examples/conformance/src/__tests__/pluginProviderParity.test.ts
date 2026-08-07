/**
 * THE PARITY PROOF — a plugin ESP, end to end (the seams plan's P3.3, its
 * acceptance criterion A4).
 *
 * The sibling suites walk the AUTHORING chain: a manifest is validated, composed
 * and rendered, and the artifact carries what was declared. That is necessary and
 * it is not the claim. The claim of Wave 3 is that a provider shipped as a
 * PACKAGE is indistinguishable from a core kind to the code that routes, falls
 * back, measures and renders — so this suite starts where those end, feeds the
 * REAL generated catalogs of `../fixtures/mockEsp` to the SHIPPED core modules,
 * and asks each of them the question a provider has to be able to answer:
 *
 *   routes + strategies    `resolveRoute` picks the plugin kind under every
 *                          strategy the registry declares
 *   dispatch               a real send, on the addressed instance's credentials,
 *                          with the extras the host's builder seam produced
 *   fallback               `isFallbackRelayEligible` and the deliverability arm
 *   reference arm          `armForTransport`, and the adaptive mix's split
 *   return path            the fold's posture, and the tier's probe boundary
 *   feedback               host verification → plugin parse → host revalidation
 *   domain identity        the plugin's observations → the host's derived status
 *   credentials UI         the form, in the vocabulary the renderer draws
 *
 * TWO OF THE CARD'S OBLIGATIONS ARE NOT MET AS WRITTEN, and finding that is this
 * piece's job rather than a shortfall of it. Neither is edited around here.
 *
 *   1. THE CREDENTIALS UI (plan A4, "renders its credentials UI") — a real gap.
 *      The form is complete on the PLUGIN's side, but no `apps/web` surface can
 *      reach it: every web lookup resolves a kind through
 *      `coreSendProviderCatalogEntry` and the editor lists `SEND_TRANSPORT_KINDS`,
 *      both core-only, because the composed plugin catalog is an `apps/api`
 *      artifact. The gap is pinned AT THE WEB SURFACE, in
 *      `apps/web/app/composables/__tests__/pluginTransportCredentialGap.test.ts`,
 *      so any shape of closure — a fallback inside `credentialFieldsFor` or a new
 *      composed view feeding it — turns that suite red. Closing it needs a card
 *      of its own (a composed-catalog view for `apps/web`; P1.2, the piece that
 *      would have owned it, has shipped), not an edit this proof may make. The
 *      report that says so where the wave gate looks — the asymmetry, the four
 *      blocked call sites, the owning card, and the line "A4 is not met until
 *      this lands" — is `.pipeline/P3.3_CREDENTIALS_UI_GAP.md`.
 *
 *   2. RETURN-PATH PROBES (plan §5's P3.3 obligation list) — SUPERSEDED, not a
 *      gap. P3.1 gave this tier `supportsCustomReturnPath: 'no'` as its only
 *      value, because the VERP local part a probe would measure is signed with a
 *      deployment secret a third-party module is never handed. So a plugin kind
 *      is unprobeable BY CONSTRUCTION and the obligation is discharged in the
 *      form the shipped contract allows: the fold READS the declaration, and the
 *      probe sweep excludes the kind. A4 (§8) does not list probes, which is the
 *      reading this suite follows; §5's line predates P3.1. The cost is recorded
 *      rather than hidden — the next case down asserts the permanent `degraded`
 *      measurement quality that follows from it.
 *
 * ZERO CORE EDITS IS ITSELF AN ASSERTION here, not a claim in a commit message:
 * the last case fails if any non-test file under `apps/` or `packages/` learns
 * this fixture's name. Everything above it runs against modules that have never
 * heard of `mock-esp`. The same case names the two test files that ARE allowed to
 * know, and pins what each must still spell — which is what binds the fixture to
 * the copies of its kind that live outside this package.
 *
 * WHY THE GENERATED ARTIFACTS ARE MOCKED AND NOTHING ELSE IS. `plugins.config.ts`
 * is empty in this repository (D4's policy is "wire it when real"), so the four
 * `*.generated.ts` files ship as empty arrays and the only way to put a plugin
 * transport in front of the core modules is to supply the composition. The values
 * supplied are the ones the REAL renderer emits for the fixture manifest
 * (`../fixtures/mockEsp/composition.ts` evaluates them out of the rendered
 * source), so a renderer that stopped carrying a field fails here rather than
 * being papered over by a hand-written entry.
 *
 * THE RAMP HALF LIVES IN `apps/api`: arm attribution has to be proven through the
 * real cron, the real outcome writers and the real controller, which need a
 * Convex database. That is
 * `apps/api/convex/delivery/ramp/__tests__/pluginReferenceArm.test.ts`, and the
 * last block reads that file back to pin it to the kind and the credential
 * variables this composition actually produces.
 */

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOSITORY_ROOT } from '../repository';
import {
	MOCK_ESP_KIND,
	MOCK_ESP_PACKAGE_NAME,
	MOCK_ESP_PLUGIN_ID,
	MOCK_ESP_SIGNATURE_HEADER,
	MOCK_ESP_TIMESTAMP_HEADER,
	MOCK_ESP_TOLERANCE_SECONDS,
} from '../fixtures/mockEsp/manifest';
// The four variable names, from the module that declares them for the whole
// bundle — the same import the fixture's own send and identity halves make.
import {
	MOCK_ESP_ENABLED_ENV,
	MOCK_ESP_REGION_ENV,
	MOCK_ESP_TOKEN_ENV,
	MOCK_ESP_WEBHOOK_SECRET_ENV,
} from '../fixtures/mockEsp/envNames';
import {
	MOCK_ESP_DKIM_SELECTOR,
	MOCK_ESP_SPF_MECHANISM,
	mockEspRegisteredDomains,
	resetMockEspRegisteredDomains,
} from '../fixtures/mockEsp/domainIdentity';
import { mockEspAttempts, resetMockEspAttempts } from '../fixtures/mockEsp/transport';

// ── The composition, in the four places a host reads it ─────────────────────
//
// Each factory imports the fixture lazily, so the mock registry does not depend
// on the order Vitest happens to evaluate this file's own imports in.

vi.mock('@owlat/api/generated/sendTransportCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: (
		await import('../fixtures/mockEsp/composition')
	).mockEspComposition().sendTransports,
}));

vi.mock('@owlat/api/generated/sendTransportWebhookCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: (
		await import('../fixtures/mockEsp/composition')
	).mockEspComposition().webhooks,
}));

vi.mock('@owlat/api/generated/sendTransportDomainIdentityCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: (
		await import('../fixtures/mockEsp/composition')
	).mockEspComposition().domainIdentities,
}));

// The plugin ROSTER, which the dispatch path re-reads to authorize the attempt
// against the manifest's declared capabilities. It is the composition itself,
// not a second declaration of it: `plugins.generated.ts` is literally
// `composeBundledPlugins([...])` over the manifest, and that is exactly the value
// the fixture's composition module already computed.
vi.mock('@owlat/api/generated/plugins', async () => ({
	bundledPluginComposition: (await import('../fixtures/mockEsp/composition')).mockEspComposition()
		.roster,
}));

// The MODULE registries codegen would emit as import statements against the
// published package. The fixture's real modules stand in for them — same shape,
// same objects the generated file would hold — keyed by the KIND the composed
// catalog carries rather than by a spelled literal, so a registry and a catalog
// cannot drift apart here in a way they could not drift apart in production.
vi.mock('@owlat/api/generated/sendTransportModules', async () => {
	const composition = (await import('../fixtures/mockEsp/composition')).mockEspComposition();
	const entry = composition.sendTransports[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: [
			{
				kind: entry['kind'],
				pluginId: entry['pluginId'],
				module: (await import('../fixtures/mockEsp/transport')).mockEspTransport,
			},
		],
	};
});

vi.mock('@owlat/api/generated/sendTransportWebhookModules', async () => {
	const composition = (await import('../fixtures/mockEsp/composition')).mockEspComposition();
	const entry = composition.webhooks[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: [
			{
				kind: entry['kind'],
				pluginId: entry['pluginId'],
				module: (await import('../fixtures/mockEsp/webhook')).mockEspWebhook,
			},
		],
	};
});

vi.mock('@owlat/api/generated/sendTransportDomainIdentityModules', async () => {
	const composition = (await import('../fixtures/mockEsp/composition')).mockEspComposition();
	const entry = composition.domainIdentities[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: [
			{
				kind: entry['kind'],
				pluginId: entry['pluginId'],
				module: (await import('../fixtures/mockEsp/domainIdentity')).mockEspDomainIdentity,
			},
		],
	};
});

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
import { buildDispatchExtrasFor } from '@owlat/api/sendProviders/registry';
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
import { sendProviderDispatch } from '@owlat/api/sendProviders/dispatch';
import { pluginSendTransportWebhookFor } from '@owlat/api/plugins/sendTransportWebhookCatalog';
import { pluginSendTransportDomainIdentityFor } from '@owlat/api/plugins/sendTransportDomainIdentityCatalog';
import { verifyPluginReplayBoundSignature } from '@owlat/api/plugins/inboundSignature';
import { parsePluginFeedbackEvents } from '@owlat/api/webhooks/pluginFeedbackEvents';
import { parsePluginRelayResult } from '@owlat/api/domains/pluginRelayState';
import {
	coreSendProviderCatalogEntry,
	OWN_SEND_PROVIDER_KIND,
	SEND_PROVIDER_CREDENTIAL_FIELD_KINDS,
} from '@owlat/shared/sendProviderCatalog';
import { mockEspComposition } from '../fixtures/mockEsp/composition';

const KIND = MOCK_ESP_KIND as SendProviderKind;
const OWN = OWN_SEND_PROVIDER_KIND as SendProviderKind;

/** Everything the fixture's credentials would be set to on a real deployment. */
const CONFIGURED: Readonly<Record<string, string>> = Object.freeze({
	[MOCK_ESP_ENABLED_ENV]: 'true',
	[MOCK_ESP_WEBHOOK_SECRET_ENV]: 'whsec-mock-esp',
	[MOCK_ESP_TOKEN_ENV]: 'tok-live',
});

/**
 * The readiness predicate `resolveRoute` is given: env presence, as shipped.
 *
 * Exactly the two kinds this suite's routes name, and no third. A predicate that
 * answered for a core kind no case routes to would read as if the proof
 * exercised a mixed pool — and it would quietly change what "unroutable" means,
 * because a rejected route falls through to `EMAIL_PROVIDER` (see the routing
 * block's stub).
 */
const configured = (kind: SendProviderKind): boolean => kind === KIND || kind === OWN;

function route(overrides: Partial<ProviderRouteConfig>): ProviderRouteConfig {
	return {
		strategy: 'single',
		providers: [{ providerType: KIND, isEnabled: true }],
		...overrides,
	};
}

describe('the bundle composes into the entry the core catalog serves', () => {
	// The join every case below stands on: the composed catalog is what
	// `sendProviderCatalogEntry` answers from, so if the fixture did not land in
	// it, every "the plugin kind is routable" assertion would be about a kind the
	// catalog invented.
	it('serves the fixture as a first-class catalog entry', () => {
		expect(isSendProviderKind(MOCK_ESP_KIND)).toBe(true);
		expect(sendProviderCatalogEntry(KIND)).toEqual(mockEspComposition().sendTransports[0]);
	});

	// THE LITERAL, spelled once. The fixture BUILDS its kind through the grammar's
	// single builder (the rule `namespacedKindGrammar.test.ts` owns), so nothing
	// here re-checks the grammar — what this pins is the resulting string, because
	// two files outside this package spell it by hand: the ramp fixture in
	// `apps/api` and the web-gap pin in `apps/web`. Renaming the plugin id or the
	// transport's local id has to fail HERE, where the rename is visible, rather
	// than leaving those two measuring a kind nothing composes.
	it('composes to the exact kind the two out-of-package fixtures spell', () => {
		expect(MOCK_ESP_KIND).toBe('plugin.mock-esp.relay');
	});

	// DERIVED, not declared. The manifest says `webhook` and `domainIdentity`; the
	// two capability words the rest of the host reads are computed from them, so a
	// bundle cannot promise feedback it has no parser for or an identity API it
	// never ships.
	it('derives the two capability words from the halves that implement them', () => {
		const entry = sendProviderCatalogEntry(KIND) as unknown as Record<string, unknown>;
		expect(entry['hasProviderFeedback']).toBe(true);
		expect(entry['domainVerification']).toBe('api');
	});

	// The tier boundary, asserted rather than assumed: a third-party transport may
	// not claim envelope-sender control (the VERP local part is signed with a
	// deployment secret it is never handed) nor pre-dispatch message-id custody.
	it('carries only the capability values this tier may declare', () => {
		const entry = sendProviderCatalogEntry(KIND) as unknown as Record<string, unknown>;
		expect(entry['supportsCustomReturnPath']).toBe('no');
		expect(entry['messageIdSource']).toBe('provider');
		expect(entry['acceptanceSemantics']).toBeUndefined();
	});
});

/**
 * EVERY strategy the registry declares, derived — never a list of four names.
 *
 * `adaptive_mix` is the one that needs a mix context to resolve at all, so it is
 * split out and driven by its own case below; the rest resolve from the route
 * alone. Deriving is what makes "under ALL strategies" survive the fifth: the
 * registry's own comment anticipates `least_loaded` / `geo_aware`, and a fifth
 * member would otherwise land with this suite green and still captioned "all
 * four" — the one suite whose job is to prove a plugin kind is routable
 * EVERYWHERE quietly stopping at four.
 */
const CONTEXT_FREE_STRATEGIES = Object.keys(SEND_ROUTE_STRATEGIES).filter(
	(strategy) => strategy !== 'adaptive_mix'
) as readonly ProviderRouteConfig['strategy'][];

describe('it appears in routes, under every declared strategy', () => {
	/**
	 * THE AMBIENT ENVIRONMENT IS NOT AN INPUT TO THIS BLOCK.
	 *
	 * A route that resolves to nothing falls through to `fallback()`, which reads
	 * the deployment's `EMAIL_PROVIDER` — a real variable for this repository. A
	 * developer or CI runner with one exported would otherwise turn "the plugin is
	 * filtered out" into "the single-transport env answered instead", failing for a
	 * reason that has nothing to do with the plugin tier. The ramp half stubs it
	 * for the same reason.
	 */
	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// The registry's four, minus the mix and minus the draw: `single` and
	// `priority_failover` are deterministic over one enabled arm. `workload_split`
	// resolves here too (a one-entry pool is a degenerate draw), and then gets its
	// own case below over a MIXED pool, which is the shape that can actually tell
	// participation from "the only entry came back".
	it.each(CONTEXT_FREE_STRATEGIES.map((strategy) => [strategy] as const))(
		'resolves the plugin transport under %s',
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
	 * ENABLED pool, so with one entry it returns that entry whatever the weighting
	 * and filtering do; the plugin arm has to be shown coming out of a pool that
	 * also holds the own MTA.
	 *
	 * Deterministic by pinning the draw at each end of the range rather than by
	 * weighting, so BOTH arms are shown to be reachable: the strategy walks the
	 * pool in route order subtracting each weight, so the bottom of the range is
	 * the first entry and the top is the last. A filter that dropped the plugin
	 * kind from the pool would return the own MTA for both.
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
	// between the own MTA and a REFERENCE arm, and the plugin transport is that
	// arm on the same terms SES is. Both degenerate shares are driven so the case
	// cannot pass by the mix simply ignoring the share.
	it.each([
		[0, KIND],
		[1, OWN],
	])('sends share %s of an adaptive_mix cell to %s', (ownShare, expected) => {
		const resolved = resolveRoute(
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
		);
		expect(resolved).toMatchObject({ providerType: expected });
	});

	// A transport whose credentials are unset is not routable, whatever the row
	// says — the same fail-closed readiness filter every core kind passes through.
	it('is filtered out of the route when its credentials are unset', () => {
		expect(resolveRoute(route({}), [], (kind) => kind !== KIND)).toBeNull();
	});
});

describe('it is fallback-eligible on the capability path (P0.2)', () => {
	it('may serve as the deliverability fallback relay', () => {
		expect(isFallbackRelayEligible(MOCK_ESP_KIND, configured)).toBe(true);
	});

	// The two halves of the gate, each pinned on its own: eligibility is a
	// CAPABILITY question (is it a known transport that is not our own MTA), and
	// configured-ness is injected by the caller.
	it('fails closed when the deployment has no credentials for it', () => {
		expect(isFallbackRelayEligible(MOCK_ESP_KIND, () => false)).toBe(false);
	});

	// THE PROOF OBLIGATION: the shipped fallback arm actually hands the send to the
	// plugin transport, with the reason the route asked for.
	it('takes over a blocklisted cell from the own MTA', () => {
		const config = route({
			strategy: 'single',
			providers: [
				{ providerType: OWN, isEnabled: true },
				{ providerType: KIND, isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: MOCK_ESP_KIND,
				isWarmupOverflowEnabled: false,
			},
		});
		expect(routeCarriesEnabledRelay(config.providers, MOCK_ESP_KIND)).toBe(true);
		expect(
			resolveRoute(config, [], configured, {
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

	// And it is held to the SAME per-domain proof gate a core relay is: eligible is
	// not sufficient. An unverified sending domain refuses the relay rather than
	// quietly handing a third party a From domain it cannot prove.
	it('is still refused for a sending domain it has not proven', () => {
		expect(() =>
			resolveRoute(
				route({
					strategy: 'single',
					providers: [
						{ providerType: OWN, isEnabled: true },
						{ providerType: KIND, isEnabled: true },
					],
					deliverabilityFallback: {
						isEnabled: true,
						relayProviderType: MOCK_ESP_KIND,
						isWarmupOverflowEnabled: false,
					},
				}),
				[],
				configured,
				{ activeReasons: ['dnsbl_listed'], isWarmupOverflow: false, isRelayDomainVerified: false }
			)
		).toThrow(DeliverabilityRouteError);
	});
});

describe('a send actually goes out through the plugin module', () => {
	/**
	 * The governed dispatch entry point, driven with the fake context the shipped
	 * plugin-dispatch suite uses: `runMutation` is the last-moment authorization
	 * recheck and `scheduler.runAfter` is where health and audit are filed. Only
	 * the generated registries are substituted; the retry loop, the authorization
	 * order and the health write are the shipped ones.
	 */
	function fakeContext(isAuthorized = true) {
		return {
			runMutation: vi.fn(async () => isAuthorized),
			scheduler: { runAfter: vi.fn(async () => undefined) },
		};
	}

	/**
	 * The mutation reference itself is `expect.anything()`, matching the shipped
	 * `pluginDispatch.integration.test.ts`: a Convex function reference is an
	 * opaque handle in this process, and what the assertion is FOR is the argument
	 * set — the plugin whose grant is being rechecked, the kind it is being
	 * rechecked for, and the attempt number that makes each retry its own decision.
	 */
	function expectAuthorizedOnce(context: ReturnType<typeof fakeContext>) {
		expect(context.runMutation).toHaveBeenCalledTimes(1);
		expect(context.runMutation).toHaveBeenCalledWith(expect.anything(), {
			pluginId: MOCK_ESP_PLUGIN_ID,
			providerKind: MOCK_ESP_KIND,
			priorAttempts: 0,
		});
	}

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// NAMED INSTANCES, which is the parity gap D4 opened and P3.1 closed. The send
	// is addressed to `#eu`, so the module must be handed the `__EU`-suffixed
	// credential — keyed by the BASE name, so a module written without knowing
	// instances exist still reads the right one. Handing it the deployment-default
	// token here would be the silent credential borrow instance resolution exists
	// to prevent.
	it("resolves the addressed instance's own credentials and hands over nothing else", async () => {
		resetMockEspAttempts();
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', `${MOCK_ESP_KIND}#eu`);
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		vi.stubEnv(`${MOCK_ESP_TOKEN_ENV}__EU`, 'tok-eu');
		// The optional variable is instance-scoped too: the DEFAULT instance's value
		// is set to something distinguishable, and the `#eu` instance's to another.
		vi.stubEnv(MOCK_ESP_REGION_ENV, 'default-region');
		vi.stubEnv(`${MOCK_ESP_REGION_ENV}__EU`, 'us');

		const context = fakeContext();
		const result = await sendProviderDispatch(context as never, `${MOCK_ESP_KIND}#eu` as never, {
			to: 'recipient@example.com',
			from: 'sender@example.com',
			subject: 'Parity',
			html: '<p>Parity</p>',
		});

		// THE GRANT IS RECHECKED BEFORE THE MODULE RUNS, on the kind the send was
		// addressed to. An instance suffix must not smuggle a send past the plugin's
		// authorization: the recheck names the bare kind, which is what the grant is
		// held against.
		expectAuthorizedOnce(context);
		expect(result).toMatchObject({
			providerType: KIND,
			transportId: `${MOCK_ESP_KIND}#eu`,
			attempts: 1,
			result: { success: true },
		});
		expect(mockEspAttempts()).toEqual([
			{
				to: 'recipient@example.com',
				instanceKey: 'eu',
				// The instance's token, never the deployment default…
				token: 'tok-eu',
				// …and the optional variable from THIS instance's suffix rather than
				// from the deployment default. Both keyed by the name the MANIFEST
				// wrote, so a module that never heard of instances reads the right one.
				region: 'us',
				extras: {},
			},
		]);
	});

	// The default instance is the same path with no suffix, and it proves the
	// suffix above was doing something rather than being the only value present.
	it('resolves the deployment-default instance for the bare kind', async () => {
		resetMockEspAttempts();
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		vi.stubEnv(`${MOCK_ESP_TOKEN_ENV}__EU`, 'tok-eu');

		await sendProviderDispatch(fakeContext() as never, KIND, {
			to: 'recipient@example.com',
			from: 'sender@example.com',
			subject: 'Parity',
			html: '<p>Parity</p>',
		});

		expect(mockEspAttempts()).toMatchObject([{ instanceKey: null, token: 'tok-live' }]);
	});

	// FAIL CLOSED BEFORE THE MODULE RUNS: a required variable this instance never
	// set is an authentication failure the host reports, not a call into
	// third-party code with an empty credential.
	it('never calls the module when a required credential is unset', async () => {
		resetMockEspAttempts();
		vi.stubEnv(MOCK_ESP_ENABLED_ENV, 'true');
		vi.stubEnv(MOCK_ESP_WEBHOOK_SECRET_ENV, 'whsec-mock-esp');

		const result = await sendProviderDispatch(fakeContext() as never, KIND, {
			to: 'recipient@example.com',
			from: 'sender@example.com',
			subject: 'Parity',
			html: '<p>Parity</p>',
		});

		expect(result.result.success).toBe(false);
		expect(mockEspAttempts()).toEqual([]);
	});

	// AND THE REVOKED GRANT, which is the other reason the module must not run.
	// The operator has taken `send:transport` away between the route resolving and
	// the attempt being made; the recheck is what notices, and it notices BEFORE
	// the send rather than after a message has left.
	it('never calls the module when the capability grant is refused', async () => {
		resetMockEspAttempts();
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);

		const context = fakeContext(false);
		const result = await sendProviderDispatch(context as never, KIND, {
			to: 'recipient@example.com',
			from: 'sender@example.com',
			subject: 'Parity',
			html: '<p>Parity</p>',
		});

		expectAuthorizedOnce(context);
		expect(result.result.success).toBe(false);
		expect(mockEspAttempts()).toEqual([]);
	});

	/**
	 * THE EXTRAS SEAM, driven end to end — the half of the bundle every other
	 * dispatch case above sees as `extras: {}`.
	 *
	 * `buildDispatchExtrasFor` is the governed boundary's ONE question ("module,
	 * what do you make of this send?"), and it asks both tiers identically. The
	 * chain here is the production one in full: the host's registry finds the
	 * hosted adapter's wrapper, the wrapper narrows `DispatchExtrasInput` to the
	 * facts a third party may see, the PLUGIN's builder turns those into its own
	 * shape, and the value comes back through `parseExtras` at the adapter's
	 * untrusted-input boundary before the module's `send` is handed it.
	 *
	 * Without this, a codegen or host change that stopped wiring
	 * `buildDispatchExtras` onto the hosted adapter would leave every case in this
	 * file green — the bundle would simply lose a declared half in silence.
	 */
	it("carries the plugin's own extras from the governed boundary into its send", async () => {
		resetMockEspAttempts();
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);

		const extras = buildDispatchExtrasFor(KIND, {
			idempotencyKey: 'send-1',
			workAttemptId: 'attempt-1',
			organizationId: 'org-1',
			messageType: 'campaign',
			deliveryDomain: 'production',
			routingReentryToken: 'token-1',
			routingReentry: {
				envelopeInput: {},
				retryState: { attempt: 0, startedAt: Date.now(), idempotencyKey: 'send-1' },
			},
		});
		// The builder read the fact it was given, not one it invented.
		expect(extras).toEqual({ campaignTag: 'campaign' });

		await sendProviderDispatch(
			fakeContext() as never,
			KIND,
			{
				to: 'recipient@example.com',
				from: 'sender@example.com',
				subject: 'Parity',
				html: '<p>Parity</p>',
			},
			extras
		);

		expect(mockEspAttempts()).toMatchObject([{ extras: { campaignTag: 'campaign' } }]);
	});
});

describe('it is a reference arm in the measurement plane', () => {
	// Attribution is decided once, at assignment time, by asking only whether the
	// transport is our own MTA. A plugin kind is `reference` for exactly the reason
	// SES is — and the ramp fixture case in `apps/api` proves the same rule holds
	// through the real outcome writers and the real controller tick.
	it('files sends on the reference arm, and the own MTA on the own arm', () => {
		expect(armForTransport(KIND)).toBe('reference');
		expect(armForTransport(OWN)).toBe('own');
	});
});

describe('the return-path plane grades it, and the probe wire stays closed', () => {
	/**
	 * THE CARD'S "gets return-path probes" OBLIGATION, DISCHARGED IN THE NEGATIVE —
	 * and the disagreement that forces it, stated rather than smoothed over.
	 *
	 * Plan §5's P3.3 line says a plugin transport "gets return-path probes"; A4
	 * (§8), the criterion the wave gate reads, does not mention probes. P3.1
	 * settled it in between: `supportsCustomReturnPath: 'no'` is the ONLY value
	 * plugin-kit lets this tier declare, because the VERP local part a probe
	 * measures is signed with a deployment secret a third-party module is never
	 * handed — a probe would spend a real bounce on the operator's ESP account to
	 * learn what the declaration already says. So the obligation is met in the only
	 * form the shipped contract has: the fold READS the declaration (the next case)
	 * and the sweep excludes the kind (this one).
	 *
	 * That is a decision with a price, and the third case prices it: a plugin ESP
	 * whose real product does support a custom return path is still graded
	 * `degraded` forever. Reopening it means widening the kit's union, which is a
	 * P3.1 change and a piece of its own — not something this proof may edit
	 * around.
	 */
	it('is never selected for a return-path probe', () => {
		expect(isProbeDecidedReturnPathKind(KIND)).toBe(false);
	});

	// The declaration is nonetheless READ, by the same fold every core kind goes
	// through, and it produces the honest posture: no envelope-sender control, so
	// the cell's bounce comparison is degraded rather than pretended comparable.
	it('resolves to an unsupported, degraded posture from its declaration alone', () => {
		const resolved = resolveReturnPathCapability(KIND, null, Date.now());
		expect(resolved).toMatchObject({
			capability: 'unsupported',
			declared: 'no',
			reason: 'declared_unsupported',
			probeStatus: 'never_probed',
		});
		expect(measurementQualityOf(resolved)).toBe('degraded');
	});

	// THE BUNDLE'S COHERENCE, visible in the controller's arithmetic: because this
	// provider ships a feedback webhook, its bounces are real data with different
	// coverage and the gate widens modestly — not the hard widening reserved for an
	// arm with no feedback at all. A bundle that dropped its webhook would move
	// this number, which is the point of asserting it.
	it('widens the bounce gate as a provider-feedback arm, not a silent one', () => {
		const resolved = resolveReturnPathCapability(KIND, null, Date.now());
		expect(resolved.bounceToleranceMultiplier).toBe(BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK);
		expect(resolved.bounceToleranceMultiplier).not.toBe(BOUNCE_TOLERANCE_MULTIPLIER_NO_FEEDBACK);
		expect(widenBounceTolerance(0.02, resolved)).toBeCloseTo(
			0.02 * BOUNCE_TOLERANCE_MULTIPLIER_PROVIDER_FEEDBACK
		);
	});
});

describe('its feedback arrives on the plugin webhook route', () => {
	// RELATIVE to the run, because the host bounds an event's timestamp against
	// the wall clock (a year back, a day forward) before it will record it — a
	// fixed epoch would have this suite start failing on a date rather than on a
	// regression.
	const NOW = Date.now();
	const BODY = JSON.stringify({
		events: [
			{ type: 'accepted', id: 'msg-1', ts: NOW - 4, email: 'a@example.com' },
			{ type: 'hard_bounce', id: 'msg-2', ts: NOW - 3, detail: '550 no such user' },
			{ type: 'spam_report', ts: NOW - 2, email: 'c@example.com' },
			{ type: 'deferral', id: 'msg-4', ts: NOW - 1, detail: '451 try later' },
			// An event kind this integration does not consume: acknowledged, never a
			// 400, or the provider would redeliver it forever.
			{ type: 'opened', id: 'msg-5', ts: NOW },
		],
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/**
	 * ONE INBOUND DELIVERY, ALWAYS THE HAPPY PATH — the provider's own bytes, the
	 * declared HMAC over `<timestamp>.<body>`, a timestamp inside the declared
	 * window.
	 *
	 * There is no knob for a tampered body, a forged signature or a stale
	 * timestamp, and there deliberately is not: every negative belongs to
	 * `verifyPluginReplayBoundSignature`'s own contract and is owned exhaustively
	 * by the two shipped suites named at the end of this block. A builder carrying
	 * overrides no case uses would advertise a capability this block does not have.
	 */
	function delivery() {
		const surface = pluginSendTransportWebhookFor(MOCK_ESP_PLUGIN_ID);
		if (!surface) throw new Error('the fixture webhook is not registered');
		const timestamp = String(Math.floor(NOW / 1000));
		const secret = CONFIGURED[MOCK_ESP_WEBHOOK_SECRET_ENV]!;
		return {
			contract: surface.definition.signature,
			pluginId: MOCK_ESP_PLUGIN_ID,
			transportKind: MOCK_ESP_KIND,
			rawBody: BODY,
			signature: createHmac('sha256', secret).update(`${timestamp}.${BODY}`).digest('hex'),
			timestamp,
			nowMs: NOW,
		};
	}

	// The route is keyed by PLUGIN ID and resolves before a byte of the body is
	// read; an unknown id is the 404 that keeps unverified traffic away from
	// signature verification entirely.
	it('registers exactly this plugin id, and nothing else', () => {
		expect(pluginSendTransportWebhookFor(MOCK_ESP_PLUGIN_ID)?.definition).toMatchObject({
			kind: MOCK_ESP_KIND,
			pluginId: MOCK_ESP_PLUGIN_ID,
			storeRawPayload: false,
		});
		expect(pluginSendTransportWebhookFor('someone-else')).toBeUndefined();
		// Map-backed, so a prototype key resolves to nothing rather than to an
		// inherited member being called as an adapter.
		expect(pluginSendTransportWebhookFor('__proto__')).toBeUndefined();
	});

	// The contract the HOST verifies with — headers, HMAC family, encoding, secret
	// variable and the bounded replay window — is the manifest's, carried through
	// codegen unaltered. The plugin never sees any of it.
	it('verifies with the declared contract', () => {
		expect(pluginSendTransportWebhookFor(MOCK_ESP_PLUGIN_ID)?.definition.signature).toEqual({
			header: MOCK_ESP_SIGNATURE_HEADER,
			algorithm: 'hmac-sha256',
			encoding: 'hex',
			secretEnvVar: MOCK_ESP_WEBHOOK_SECRET_ENV,
			replay: {
				timestampHeader: MOCK_ESP_TIMESTAMP_HEADER,
				toleranceSeconds: MOCK_ESP_TOLERANCE_SECONDS,
			},
		});
	});

	// THE HAPPY PATH, all three links: the host proves authenticity, the plugin
	// turns verified bytes into feedback facts, and the host re-validates that
	// output and stamps the transport kind itself — so a plugin cannot attribute a
	// bounce to somebody else's arm.
	//
	// THROUGH THE LOOKUP, not through the fixture import. The route resolves a
	// module by plugin id and then calls it; calling `mockEspWebhook` directly here
	// would leave a registry that returned SOMEBODY ELSE's parser for this id
	// perfectly green, which is the one join this block exists to prove.
	it('verifies, parses and revalidates a signed batch into four feedback facts', async () => {
		vi.stubEnv(MOCK_ESP_WEBHOOK_SECRET_ENV, CONFIGURED[MOCK_ESP_WEBHOOK_SECRET_ENV]!);
		const surface = pluginSendTransportWebhookFor(MOCK_ESP_PLUGIN_ID);
		if (!surface) throw new Error('the fixture webhook is not registered');
		const verified = await verifyPluginReplayBoundSignature(delivery());
		expect(verified.ok).toBe(true);

		const events = parsePluginFeedbackEvents(surface.module.parseEvents(BODY), MOCK_ESP_KIND);
		expect(events.map((event) => event.kind)).toEqual([
			'email.delivered',
			'email.bounced',
			'email.complained',
			'email.deferred',
		]);
		// The arm every one of them is graded against is stamped by the HOST from the
		// route's registration, never taken from the plugin's output.
		expect(
			events.every(
				(event) =>
					'providerType' in event &&
					(event as { readonly providerType?: string }).providerType === MOCK_ESP_KIND
			)
		).toBe(true);
	});

	/*
	 * THE VERIFIER'S NEGATIVES ARE NOT RESTATED HERE, deliberately.
	 *
	 * Tampered body, forged signature, replay outside the window, malformed or
	 * rewritten timestamp, a tolerance beyond the kit's ceiling and the 503 an
	 * unset secret answers are `verifyPluginReplayBoundSignature`'s own contract,
	 * and two shipped suites already own it exhaustively:
	 * `apps/api/convex/plugins/__tests__/inboundSignature.test.ts` at the verifier
	 * and `apps/api/convex/webhooks/__tests__/pluginFeedbackRoute.test.ts` at the
	 * route. A third copy would not add a case; it would add a third file to edit
	 * when the contract moves, and a third chance for the copies to disagree —
	 * which is the duplication class this whole plan exists to remove. What is
	 * fixture-specific, and therefore lives here, is the registration by plugin id,
	 * the declared contract surviving codegen, and the verify → parse → revalidate
	 * chain above.
	 */
});

describe('it proves a sending domain through its identity module', () => {
	const config = { instanceKey: null, env: { [MOCK_ESP_TOKEN_ENV]: 'tok-live' } };

	/**
	 * THE MODULE THE HOST WOULD CALL, resolved the way the host resolves it — by
	 * NAMESPACED KIND, which is how this registry is keyed (the feedback one is
	 * keyed by plugin id, because its route surface is).
	 *
	 * Calling the imported fixture object directly would leave a registry that
	 * keyed identities by `pluginId` — or that returned another plugin's module for
	 * a colliding key — perfectly green while the host asked the wrong third party
	 * whether this domain is proven.
	 */
	function identityModule() {
		const surface = pluginSendTransportDomainIdentityFor(MOCK_ESP_KIND);
		if (!surface) throw new Error('the fixture domain identity is not registered');
		return surface.module;
	}

	it('is registered as a sending-domain identity provider for its own kind', () => {
		expect(pluginSendTransportDomainIdentityFor(MOCK_ESP_KIND)?.definition).toMatchObject({
			kind: MOCK_ESP_KIND,
			pluginId: MOCK_ESP_PLUGIN_ID,
			requiredEnvVars: [MOCK_ESP_TOKEN_ENV],
		});
	});

	// THE SPLIT: the plugin returns observations, the HOST derives the status. The
	// module has no `status` field to return, which is what makes "verified" mean
	// the same thing at every relay tier.
	it('derives verified from the observations the module reported', async () => {
		resetMockEspRegisteredDomains();
		const outcome = parsePluginRelayResult(
			await identityModule().registerDomain('sender.example.com', config)
		);
		expect(outcome).toEqual({
			outcome: 'ok',
			observation: {
				status: 'verified',
				spf: { isValid: true },
				dkim: { isValid: true },
				dkimSelectors: [MOCK_ESP_DKIM_SELECTOR],
				spfMechanisms: [MOCK_ESP_SPF_MECHANISM],
			},
		});
		// The WRITE call reached the provider — the half `checkDomain` must not do.
		expect(mockEspRegisteredDomains()).toEqual(['sender.example.com']);
	});

	it.each([
		['pending.example.com', 'pending_dns'],
		['unknown.example.com', 'unverified'],
	])('derives %s as %s', async (domain, status) => {
		const outcome = parsePluginRelayResult(await identityModule().checkDomain(domain, config));
		expect(outcome.outcome === 'ok' ? outcome.observation.status : null).toBe(status);
	});

	// A credential the provider rejected is TERMINAL and says so — distinguishable
	// from an outage, because the host's write rules differ: only this one condemns
	// a credential, and neither refreshes the proof's age.
	it('reports a rejected credential as auth_failed, not as an outage', async () => {
		const outcome = parsePluginRelayResult(
			await identityModule().checkDomain('sender.example.com', {
				instanceKey: 'eu',
				env: {},
			})
		);
		expect(outcome.outcome).toBe('auth_failed');
	});

	// Untrusted output is untrusted output: a shape the host does not recognise is
	// `unavailable` — evidence of nothing — never a verdict that could mark a
	// domain unverified while refreshing the freshness clock.
	it('reads a malformed module answer as unavailable', () => {
		expect(parsePluginRelayResult({ outcome: 'ok' }).outcome).toBe('unavailable');
	});
});

describe('its credentials form is a descriptor set the UI vocabulary can draw', () => {
	/**
	 * THE DESCRIPTORS AS THE COMPOSED ENTRY CARRIES THEM — read off the catalog a
	 * renderer would read, not off the manifest, because the entry is what the UI
	 * sees and the join below is only meaningful there.
	 */
	const fields = mockEspComposition().sendTransports[0]!['credentialFields'] as
		| readonly Record<string, unknown>[]
		| undefined;

	/*
	 * THE COMPILE-TIME JOIN BETWEEN THE TWO VOCABULARIES IS NOT RESTATED HERE.
	 *
	 * `packages/shared` may not depend on `@owlat/plugin-kit`, so
	 * `PluginSendTransportCredentialField` and the catalog's
	 * `SendProviderCredentialField` are two declarations that must stay
	 * assignable — and the assertion that they are lives, without a cast, in
	 * `apps/api/convex/lib/sendProviders/__tests__/credentialFieldVocabulary.test.ts`
	 * (`_pluginDescriptorsAreCatalogDescriptors`). A second version of it here
	 * could only be written through this file's `Record<string, unknown>` view of
	 * the evaluated artifact, i.e. through a cast — which compiles whatever either
	 * union does, and would be a dead statement carrying a claim a later reader
	 * would trust. What this block asserts instead is the RUN-TIME half: that the
	 * values the renderer would draw are in the vocabulary it can draw.
	 */

	it('declares its form in the shared field vocabulary', () => {
		expect(fields).toBeDefined();
		for (const field of fields ?? []) {
			expect(SEND_PROVIDER_CREDENTIAL_FIELD_KINDS).toContain(field['kind']);
		}
		// Both drawings the fixture exercises: the masked one and a closed set.
		expect((fields ?? []).map((field) => field['kind'])).toEqual(['secret', 'select']);
	});

	// THE JOIN THAT MAKES A FORM HONEST: every variable the form writes is one the
	// transport declared, and the required/optional split matches the field's own
	// `required`. A form asking for a variable no send reads, or omitting one that
	// gates the transport, is refused at manifest validation — this asserts the
	// property survives composition into the entry a renderer actually reads.
	it('asks only for variables this transport reads, in the right list', () => {
		const entry = mockEspComposition().sendTransports[0]!;
		const required = new Set(entry['requiredEnvVars'] as readonly string[]);
		const optional = new Set(entry['optionalEnvVars'] as readonly string[]);
		for (const field of fields ?? []) {
			const envVar = field['envVar'] as string;
			expect(field['required'] === true ? required.has(envVar) : optional.has(envVar)).toBe(true);
		}
	});

	// The renderer keys its form state by ENV VARIABLE and never renders a `secret`
	// back, so the descriptor is what tells a surface which value is write-only.
	it('marks its API token as a secret field, and its region as a closed set', () => {
		expect((fields ?? []).find((field) => field['envVar'] === MOCK_ESP_TOKEN_ENV)).toMatchObject({
			kind: 'secret',
			required: true,
		});
		expect((fields ?? []).find((field) => field['envVar'] === MOCK_ESP_REGION_ENV)).toMatchObject({
			kind: 'select',
			default: 'eu',
			options: [
				{ value: 'eu', label: 'Europe' },
				{ value: 'us', label: 'United States' },
			],
		});
	});

	/**
	 * THE GAP THIS PIECE FOUND, STATED WHERE ITS ARCHITECTURE IS.
	 *
	 * Everything above is the PLUGIN's half of D5 and it is complete: the bundle
	 * ships a form in the vocabulary `TransportCredentialFields.vue` draws, joined
	 * to the variables its sends read. The HOST's half is not, and the shape of the
	 * shortfall is exactly this asymmetry: the BACKEND's lookup composes both
	 * tiers, while the lookup every `apps/web` surface reaches for is core-only by
	 * construction and by name. So a plugin transport renders no form today — not
	 * because the renderer knows about providers (it does not) but because the
	 * descriptors never reach it.
	 *
	 * THE BEHAVIOURAL PIN IS AT THE WEB SURFACE, not here:
	 * `apps/web/app/composables/__tests__/pluginTransportCredentialGap.test.ts`
	 * drives `credentialFieldsFor` / `seedCredentialValues` /
	 * `transportCredentialEnv` — the three functions the wizard and the editor
	 * actually call — and turns red on ANY shape of closure, including a fallback
	 * added inside `credentialFieldsFor` that would leave a source-text pin here
	 * green forever. This case asserts only the architectural fact that explains
	 * it, which is the fact this package can see.
	 */
	it('is composed for the backend and invisible to the shared, core-only view', () => {
		expect(sendProviderCatalogEntry(KIND)).toBeDefined();
		expect(coreSendProviderCatalogEntry(MOCK_ESP_KIND)).toBeUndefined();
	});
});

describe('none of it required a core edit', () => {
	/**
	 * THE HEADLINE CLAIM, ASSERTED. Everything above runs against shipped modules;
	 * this checks that no PRODUCTION file learned the fixture exists.
	 *
	 * Two test files under `apps/` are exempt and named, because each proves a half
	 * of this proof that cannot live in this package: the ramp fixture needs a
	 * Convex database, and the credentials-gap pin needs `apps/web`'s own module
	 * graph. `--untracked` so a file added in this working tree counts.
	 */
	const RAMP_FIXTURE = 'apps/api/convex/delivery/ramp/__tests__/pluginReferenceArm.test.ts';
	const WEB_GAP_PIN = 'apps/web/app/composables/__tests__/pluginTransportCredentialGap.test.ts';

	it('leaves every non-test file under apps/ and packages/ ignorant of the fixture', () => {
		const hits = execFileSync(
			'git',
			[
				'grep',
				'-lI',
				'--untracked',
				'-e',
				MOCK_ESP_PLUGIN_ID,
				'-e',
				MOCK_ESP_PACKAGE_NAME,
				'--',
				'apps',
				'packages',
			],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		)
			.split('\n')
			.filter((line) => line.length > 0);

		expect(hits.filter((path) => !path.includes('/__tests__/'))).toEqual([]);
		// And the two test files that ARE allowed to know.
		expect([...hits].sort()).toEqual([RAMP_FIXTURE, WEB_GAP_PIN]);
	});

	/**
	 * THE BINDING THE TWO OUT-OF-PACKAGE FIXTURES CANNOT HAVE ANY OTHER WAY.
	 *
	 * Neither `apps/api` nor `apps/web` may import from `examples/`, so both spell
	 * this fixture's kind by hand — and a hand-spelled kind is exactly the thing
	 * that keeps passing after the fixture it names has moved. The grep above only
	 * proves each file mentions the plugin ID; this proves each names the FULL
	 * composed kind, so changing the transport's local id (`relay`) fails here
	 * rather than leaving a ramp suite grading a kind nothing composes and a web
	 * pin guarding a kind no renderer will ever be asked for.
	 *
	 * The ramp fixture additionally restates the composed entry's configuration
	 * variables, so those are bound too — a renderer that stopped folding the
	 * flag's `requiredEnvVars` into the entry, or that stopped composing
	 * `instanceEnvVars` from the required and optional lists, moves one of these
	 * lists. Those two are the whole of what the ramp fixture's narrowed entry
	 * carries as data, so nothing in it is unbound.
	 */
	it.each([[RAMP_FIXTURE], [WEB_GAP_PIN]])('binds %s to the composed kind', (path) => {
		const source = readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
		expect(source).toContain(MOCK_ESP_KIND);
	});

	it('binds the ramp fixture to the composed configuration variables', () => {
		const source = readFileSync(resolve(REPOSITORY_ROOT, RAMP_FIXTURE), 'utf8');
		const entry = mockEspComposition().sendTransports[0]!;
		const declared = [
			...(entry['requiredEnvVars'] as readonly string[]),
			...(entry['instanceEnvVars'] as readonly string[]),
		];
		expect(declared.length).toBeGreaterThan(0);
		for (const envVar of declared) {
			expect(source, `the ramp fixture no longer names ${envVar}`).toContain(envVar);
		}
	});
});
