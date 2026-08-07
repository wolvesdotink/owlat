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
 *   routes + strategies    `resolveRoute` picks the plugin kind under all four
 *   dispatch               a real send, on the addressed instance's credentials
 *   fallback               `isFallbackRelayEligible` and the deliverability arm
 *   reference arm          `armForTransport`, and the adaptive mix's split
 *   return path            the fold's posture, and the tier's probe boundary
 *   feedback               host verification → plugin parse → host revalidation
 *   domain identity        the plugin's observations → the host's derived status
 *   credentials UI         the form, in the vocabulary the renderer draws
 *
 * ONE OBLIGATION IS NOT MET, and finding that is this piece's job rather than a
 * shortfall of it. The credential FORM is complete on the plugin's side, but no
 * `apps/web` surface can reach it: every web lookup resolves a kind through
 * `coreSendProviderCatalogEntry` and the editor lists `SEND_TRANSPORT_KINDS`,
 * both core-only, because the composed plugin catalog is an `apps/api` artifact.
 * The last case of the credentials block pins that state so it fails the day it
 * changes; closing it is a web-side piece, not an edit this proof may make.
 *
 * ZERO CORE EDITS IS ITSELF AN ASSERTION here, not a claim in a commit message:
 * the last case fails if any non-test file under `apps/` or `packages/` learns
 * this fixture's name. Everything above it runs against modules that have never
 * heard of `mock-esp`.
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
 * kind-grammar case below pins the two fixtures to the same transport kind.
 */

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPOSITORY_ROOT } from '../repository';
import {
	MOCK_ESP_ENABLED_ENV,
	MOCK_ESP_KIND,
	MOCK_ESP_LOCAL_ID,
	MOCK_ESP_PACKAGE_NAME,
	MOCK_ESP_PLUGIN_ID,
	MOCK_ESP_REGION_ENV,
	MOCK_ESP_SIGNATURE_HEADER,
	MOCK_ESP_TIMESTAMP_HEADER,
	MOCK_ESP_TOKEN_ENV,
	MOCK_ESP_TOLERANCE_SECONDS,
	MOCK_ESP_WEBHOOK_SECRET_ENV,
} from '../fixtures/mockEsp/manifest';
import {
	MOCK_ESP_DKIM_SELECTOR,
	MOCK_ESP_SPF_MECHANISM,
	mockEspDomainIdentity,
	mockEspRegisteredDomains,
	resetMockEspRegisteredDomains,
} from '../fixtures/mockEsp/domainIdentity';
import { mockEspAttempts, resetMockEspAttempts } from '../fixtures/mockEsp/transport';
import { mockEspWebhook } from '../fixtures/mockEsp/webhook';

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

// The MODULE registries codegen would emit as import statements against the
// published package. The fixture's real modules stand in for them — same shape,
// same objects the generated file would hold.
vi.mock('@owlat/api/generated/sendTransportModules', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: [
		{
			kind: `plugin.mock-esp.relay`,
			pluginId: 'mock-esp',
			module: (await import('../fixtures/mockEsp/transport')).mockEspTransport,
		},
	],
}));

// The plugin ROSTER, which the dispatch path re-reads to authorize the attempt
// against the manifest's declared capabilities. It is the composition the host
// would hold, not a second declaration: the same package name, id and flag the
// fixture manifest carries.
vi.mock('@owlat/api/generated/plugins', () => ({
	bundledPluginComposition: [
		{
			packageName: '@acme/mock-esp',
			manifest: {
				id: 'mock-esp',
				version: '1.0.0',
				capabilities: ['send:transport'],
				flag: {
					default: false,
					requiredEnvVars: ['MOCK_ESP_ENABLED', 'PLUGIN_MOCK_ESP_WEBHOOK_SECRET'],
				},
			},
		},
	],
}));

vi.mock('@owlat/api/generated/sendTransportWebhookModules', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: [
		{
			kind: `plugin.mock-esp.relay`,
			pluginId: 'mock-esp',
			module: (await import('../fixtures/mockEsp/webhook')).mockEspWebhook,
		},
	],
}));

vi.mock('@owlat/api/generated/sendTransportDomainIdentityModules', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: [
		{
			kind: `plugin.mock-esp.relay`,
			pluginId: 'mock-esp',
			module: (await import('../fixtures/mockEsp/domainIdentity')).mockEspDomainIdentity,
		},
	],
}));

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
	OWN_SEND_PROVIDER_KIND,
	SEND_PROVIDER_CREDENTIAL_FIELD_KINDS,
	type SendProviderCredentialField,
} from '@owlat/shared/sendProviderCatalog';
import { pluginNamespacedKind } from '@owlat/plugin-kit';
import { mockEspComposition } from '../fixtures/mockEsp/composition';

const KIND = MOCK_ESP_KIND as SendProviderKind;
const OWN = OWN_SEND_PROVIDER_KIND as SendProviderKind;

/** Everything the fixture's credentials would be set to on a real deployment. */
const CONFIGURED: Readonly<Record<string, string>> = Object.freeze({
	[MOCK_ESP_ENABLED_ENV]: 'true',
	[MOCK_ESP_WEBHOOK_SECRET_ENV]: 'whsec-mock-esp',
	[MOCK_ESP_TOKEN_ENV]: 'tok-live',
});

/** The readiness predicate `resolveRoute` is given: env presence, as shipped. */
const configured = (kind: SendProviderKind): boolean =>
	kind === KIND || kind === OWN || kind === 'ses';

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

	// The kind is built by the grammar's single builder, never spelled: the same
	// rule `namespacedKindGrammar.test.ts` holds every reference plugin to, and
	// what binds this fixture to the ramp case in `apps/api`.
	it('is named by the one namespaced-kind builder', () => {
		expect(MOCK_ESP_KIND).toBe(pluginNamespacedKind(MOCK_ESP_PLUGIN_ID, MOCK_ESP_LOCAL_ID));
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

describe('it appears in routes, under all four strategies', () => {
	// `single` and `priority_failover` are deterministic over one enabled arm;
	// `workload_split` draws, so it gets the whole route to itself, which is the
	// shipped degenerate case rather than a stubbed random.
	it.each([['single'], ['priority_failover'], ['workload_split']] as const)(
		'resolves the plugin transport under %s',
		(strategy) => {
			expect(resolveRoute(route({ strategy }), [], configured)).toMatchObject({
				providerType: KIND,
				source: 'org_config',
			});
		}
	);

	// THE FOURTH, and the one that matters most: `adaptive_mix` splits a cell
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
	function fakeContext() {
		return {
			runMutation: vi.fn(async () => true),
			scheduler: { runAfter: vi.fn(async () => undefined) },
		};
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

		const result = await sendProviderDispatch(
			fakeContext() as never,
			`${MOCK_ESP_KIND}#eu` as never,
			{
				to: 'recipient@example.com',
				from: 'sender@example.com',
				subject: 'Parity',
				html: '<p>Parity</p>',
			}
		);

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
	// THE TIER BOUNDARY, pinned in the direction that matters. `probe` is a value
	// the kit refuses this tier, so the sweep must not consider a plugin transport
	// probeable: doing so would spend a real bounce on the operator's ESP account
	// to learn what the declaration already says.
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

	function sign(
		body: string,
		timestamp: string,
		secret = CONFIGURED[MOCK_ESP_WEBHOOK_SECRET_ENV]!
	) {
		return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
	}

	/**
	 * One inbound delivery, signed correctly unless an override says otherwise.
	 *
	 * `signedBody` is what the HMAC was computed over and `rawBody` is what
	 * arrived: equal on the happy path, and different exactly when a case means to
	 * model a body rewritten after signing.
	 */
	function delivery(overrides: Partial<Record<'rawBody' | 'signature' | 'timestamp', string>>) {
		const surface = pluginSendTransportWebhookFor(MOCK_ESP_PLUGIN_ID);
		if (!surface) throw new Error('the fixture webhook is not registered');
		const timestamp = overrides.timestamp ?? String(Math.floor(NOW / 1000));
		return {
			contract: surface.definition.signature,
			pluginId: MOCK_ESP_PLUGIN_ID,
			transportKind: MOCK_ESP_KIND,
			rawBody: overrides.rawBody ?? BODY,
			signature: overrides.signature ?? sign(BODY, timestamp),
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
	it('verifies, parses and revalidates a signed batch into four feedback facts', async () => {
		vi.stubEnv(MOCK_ESP_WEBHOOK_SECRET_ENV, CONFIGURED[MOCK_ESP_WEBHOOK_SECRET_ENV]!);
		const verified = await verifyPluginReplayBoundSignature(delivery({}));
		expect(verified.ok).toBe(true);

		const events = parsePluginFeedbackEvents(mockEspWebhook.parseEvents(BODY), MOCK_ESP_KIND);
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

	it.each([
		['a body that was tampered with after signing', { rawBody: '{"events":[]}' }],
		['a forged signature', { signature: 'f'.repeat(64) }],
		[
			'a capture replayed outside the declared window',
			{ timestamp: String(Math.floor(NOW / 1000) - MOCK_ESP_TOLERANCE_SECONDS - 60) },
		],
	])('refuses %s', async (_label, overrides) => {
		vi.stubEnv(MOCK_ESP_WEBHOOK_SECRET_ENV, CONFIGURED[MOCK_ESP_WEBHOOK_SECRET_ENV]!);
		const result = await verifyPluginReplayBoundSignature(delivery(overrides));
		expect(result.ok).toBe(false);
		expect(result.ok ? 0 : result.status).toBe(401);
	});

	// An unset signing secret is the DEPLOYMENT's problem and is answered 503, so
	// an operator wiring the endpoint up is not told their provider is forging.
	it('answers 503 while the signing secret is unset', async () => {
		const result = await verifyPluginReplayBoundSignature(delivery({}));
		expect(result.ok ? 0 : result.status).toBe(503);
	});
});

describe('it proves a sending domain through its identity module', () => {
	const config = { instanceKey: null, env: { [MOCK_ESP_TOKEN_ENV]: 'tok-live' } };

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
			await mockEspDomainIdentity.registerDomain('sender.example.com', config)
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
		const outcome = parsePluginRelayResult(await mockEspDomainIdentity.checkDomain(domain, config));
		expect(outcome.outcome === 'ok' ? outcome.observation.status : null).toBe(status);
	});

	// A credential the provider rejected is TERMINAL and says so — distinguishable
	// from an outage, because the host's write rules differ: only this one condemns
	// a credential, and neither refreshes the proof's age.
	it('reports a rejected credential as auth_failed, not as an outage', async () => {
		const outcome = parsePluginRelayResult(
			await mockEspDomainIdentity.checkDomain('sender.example.com', {
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

	/**
	 * COMPILE-TIME: a plugin's descriptors are the SHARED catalog's
	 * `SendProviderCredentialField` — the same type
	 * `TransportCredentialFields.vue` and `setupWizardCredentials.ts` are written
	 * against. `packages/shared` may not depend on `@owlat/plugin-kit`, so the two
	 * declarations cannot be one; this assignment is what holds them together from
	 * the consuming side, and it fails the build if either narrows away from the
	 * other.
	 */
	const _rendersAsCatalogFields: readonly SendProviderCredentialField[] = (fields ??
		[]) as unknown as readonly SendProviderCredentialField[];
	void _rendersAsCatalogFields;

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
	 * THE GAP THIS PIECE FOUND, PINNED AS IT STANDS.
	 *
	 * Everything above is the PLUGIN's half of D5 and it is complete: the bundle
	 * ships a form in the vocabulary `TransportCredentialFields.vue` draws, joined
	 * to the variables its sends read. The HOST's half is not: every web lookup
	 * resolves a kind through `coreSendProviderCatalogEntry`
	 * (`credentialFieldsFor`, `transportState`, `deliveryEnvSnippet`) and the
	 * editor lists `SEND_TRANSPORT_KINDS`, both of which are CORE-ONLY — the
	 * composed plugin catalog is an `apps/api` artifact and `apps/web` has no view
	 * of it. So a plugin transport renders no form today, not because the renderer
	 * knows about providers (it does not) but because the descriptors never reach
	 * it.
	 *
	 * Closing it is a web-side piece (a composed-catalog view for `apps/web`), not
	 * an edit this proof may make — see the piece's report. Pinned rather than
	 * skipped so the day it closes, this case fails and gets deleted.
	 */
	it('is not yet reachable from apps/web, whose catalog view is core-only', () => {
		const webCatalogView = execFileSync(
			'git',
			[
				'grep',
				'-c',
				'coreSendProviderCatalogEntry',
				'--',
				'apps/web/app/composables/setupWizardCredentials.ts',
			],
			{ cwd: REPOSITORY_ROOT, encoding: 'utf8' }
		).trim();
		expect(Number(webCatalogView.split(':').pop())).toBeGreaterThan(0);
	});
});

describe('none of it required a core edit', () => {
	/**
	 * THE HEADLINE CLAIM, ASSERTED. Everything above runs against shipped modules;
	 * this checks that no PRODUCTION file learned the fixture exists.
	 *
	 * Test files under `apps/` are exempt and named: the ramp fixture case is the
	 * half of this proof that needs a Convex database, and it necessarily spells
	 * the kind. `--untracked` so a file added in this working tree counts.
	 */
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
		// And the one test file that IS allowed to know: the ramp half.
		expect(hits).toEqual(['apps/api/convex/delivery/ramp/__tests__/pluginReferenceArm.test.ts']);
	});
});
