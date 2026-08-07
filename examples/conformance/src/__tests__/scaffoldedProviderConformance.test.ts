/**
 * THE SCAFFOLD'S CONFORMANCE GATE — `owlat plugins create --template
 * send-provider` output, driven UNMODIFIED through the shipped core modules (the
 * seams plan's P3.4, its acceptance criterion A7).
 *
 * P3.3's parity proof (`pluginProviderParity.test.ts`) answers "can a package be
 * a provider?" against a hand-written fixture ESP. This one answers the question
 * D4's policy actually rests on — "is the package we HAND an author already such
 * a provider?" — and it answers it against the generator's real output: the
 * subject is `../fixtures/scaffolded/bundle.ts`, which calls `buildScaffold`,
 * writes the emitted files to a directory, imports the emitted TypeScript and
 * composes it through the real host and renderer. No file is edited in between,
 * and the last block asserts that mechanically.
 *
 * WHY THIS IS NOT THE SAME SUITE AS THE PARITY PROOF, run twice. That suite is
 * bound to its fixture's wire shapes, its recorded-attempt log and its declared
 * env-var names, all of which are the FIXTURE's choices. What is asserted here is
 * only what the TEMPLATE must be true of, and every subject-specific value —
 * the kind, the variable names, the webhook secret, the credential fields — is
 * read off the composed artifact rather than spelled, so a template that renames
 * anything is still measured against what it now declares.
 *
 * WHAT IT DOES NOT RE-PROVE. The negative half of signature verification
 * (tampered body, forged signature, stale timestamp, unset secret), the
 * per-adapter route behaviour, and the ramp controller's tick are owned
 * exhaustively by the shipped suites named in `pluginProviderParity.test.ts`'s
 * feedback block and by that file's `apps/api` ramp half. A second copy here
 * would add no case and one more place to edit.
 */

import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── The composition, in the four places a host reads it ─────────────────────
//
// Each factory awaits the fixture lazily, so the mock registry does not depend on
// the order Vitest evaluates this file's own imports in. The fixture memoizes the
// PROMISE, so all five frames below share one materialised bundle.

vi.mock('@owlat/api/generated/sendTransportCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).sendTransports,
}));

vi.mock('@owlat/api/generated/sendTransportWebhookCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_CATALOG: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).webhooks,
}));

vi.mock('@owlat/api/generated/sendTransportDomainIdentityCatalog', async () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).domainIdentities,
}));

vi.mock('@owlat/api/generated/plugins', async () => ({
	bundledPluginComposition: (
		await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle()
	).roster,
}));

vi.mock('@owlat/api/generated/sendTransportModules', async () => {
	const bundle = await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle();
	const entry = bundle.sendTransports[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_MODULES: [
			{ kind: entry['kind'], pluginId: entry['pluginId'], module: bundle.transport },
		],
	};
});

vi.mock('@owlat/api/generated/sendTransportWebhookModules', async () => {
	const bundle = await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle();
	const entry = bundle.webhooks[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_WEBHOOK_MODULES: [
			{ kind: entry['kind'], pluginId: entry['pluginId'], module: bundle.webhook },
		],
	};
});

vi.mock('@owlat/api/generated/sendTransportDomainIdentityModules', async () => {
	const bundle = await (await import('../fixtures/scaffolded/bundle')).scaffoldedBundle();
	const entry = bundle.domainIdentities[0]!;
	return {
		BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: [
			{ kind: entry['kind'], pluginId: entry['pluginId'], module: bundle.domainIdentity },
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
import { EmailErrorCode } from '@owlat/api/sendProviders/types';
import { isFallbackRelayEligible } from '@owlat/api/sendProviders/fallbackEligibility';
import {
	measurementQualityOf,
	resolveReturnPathCapability,
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
} from '@owlat/shared/sendProviderCatalog';
import {
	cleanupScaffoldedBundle,
	SCAFFOLDED_PACKAGE_NAME,
	SCAFFOLDED_PLUGIN_ID,
	scaffoldedBundle,
	type ScaffoldedBundle,
} from '../fixtures/scaffolded/bundle';

/**
 * The bundle, resolved once for the whole file.
 *
 * `await` at module scope rather than in a `beforeAll`, because the derived
 * constants below (the kind, the variable names, the signature contract) are what
 * every `describe` is written against, and a hook would leave them undefined
 * while the collector ran.
 */
const bundle: ScaffoldedBundle = await scaffoldedBundle();
const entry = bundle.sendTransports[0]!;
const webhookEntry = bundle.webhooks[0]!;

const KIND = entry['kind'] as SendProviderKind;
const OWN = OWN_SEND_PROVIDER_KIND as SendProviderKind;

/**
 * EVERY VARIABLE NAME IS READ OFF THE COMPOSED BUNDLE, never spelled. The
 * template derives them from the plugin id, so spelling them here would pin this
 * suite to one generator revision and quietly stop measuring the next.
 *
 * THE TWO SCOPES ARE READ FROM DIFFERENT PLACES, because they mean different
 * things and the composition folds one into the other. The MANIFEST's transport
 * contribution carries what one INSTANCE needs (the names that take an
 * `__<INSTANCEKEY>` suffix); the plugin's `flag` carries the deployment-wide
 * gate; and the composed ENTRY's `requiredEnvVars` is the union of both — the
 * presence list `providerKindConfigured` answers from. Reading the instance
 * credential off the entry would hand a domain-identity module the enablement
 * switch as its API key.
 */
const manifest = (bundle.roster[0]! as unknown as Record<string, unknown>)['manifest'] as Record<
	string,
	unknown
>;
const contribution = (
	(manifest['contributes'] as Record<string, unknown>)['sendTransports'] as readonly Record<
		string,
		unknown
	>[]
)[0]!;
const INSTANCE_REQUIRED_ENV = contribution['requiredEnvVars'] as readonly string[];
const INSTANCE_OPTIONAL_ENV = contribution['optionalEnvVars'] as readonly string[];
/** The plugin's deployment-wide gate, as the composed roster carries it. */
const FLAG_ENV = manifest['flag'] as { readonly requiredEnvVars: readonly string[] };
/** The composed presence list: the fold of both scopes. */
const ENTRY_REQUIRED_ENV = entry['requiredEnvVars'] as readonly string[];

const SIGNATURE = webhookEntry['signature'] as {
	readonly header: string;
	readonly algorithm: string;
	readonly encoding: string;
	readonly secretEnvVar: string;
	readonly replay: { readonly timestampHeader: string; readonly toleranceSeconds: number };
};

/** The transport's own credential — the value a send must go out on. */
const DEFAULT_CREDENTIAL = 'default-instance-key';

/** Everything a real deployment would set for this bundle. */
const CONFIGURED: Readonly<Record<string, string>> = Object.freeze({
	...Object.fromEntries(FLAG_ENV.requiredEnvVars.map((name) => [name, 'set'])),
	[SIGNATURE.secretEnvVar]: 'whsec-scaffolded',
	...Object.fromEntries(INSTANCE_REQUIRED_ENV.map((name) => [name, DEFAULT_CREDENTIAL])),
});

const configured = (kind: SendProviderKind): boolean => kind === KIND || kind === OWN;

function route(overrides: Partial<ProviderRouteConfig>): ProviderRouteConfig {
	return {
		strategy: 'single',
		providers: [{ providerType: KIND, isEnabled: true }],
		...overrides,
	};
}

afterAll(async () => {
	await cleanupScaffoldedBundle();
});

describe('the emitted bundle composes into a first-class catalog entry', () => {
	it('validates, composes and is served by the shipped catalog', () => {
		// The fixture throws if the emitted manifest fails validation, so reaching
		// this line is already half the claim; the other half is that the composed
		// entry is what the core catalog answers with.
		expect(isSendProviderKind(KIND)).toBe(true);
		expect(sendProviderCatalogEntry(KIND)).toEqual(entry);
	});

	it('composes to the kind the plugin id and the transport local id imply', () => {
		expect(KIND).toBe(`plugin.${SCAFFOLDED_PLUGIN_ID}.relay`);
		expect(entry['pluginId']).toBe(SCAFFOLDED_PLUGIN_ID);
	});

	/**
	 * THE TEMPLATE'S CENTRAL EDITING HAZARD, pinned. `hasProviderFeedback` and
	 * `domainVerification` are DERIVED from the presence of the webhook and the
	 * domain-identity halves — an author who deletes a half they do not need must
	 * lose the promise with it, and an author who keeps both must get both. A
	 * template that emitted the words as fields could disagree with its own files.
	 */
	it('derives both capability words from the halves it emitted', () => {
		expect(entry['hasProviderFeedback']).toBe(true);
		expect(entry['domainVerification']).toBe('api');
	});

	it('declares only capability values this tier may hold', () => {
		expect(entry['supportsCustomReturnPath']).toBe('no');
		expect(entry['messageIdSource']).toBe('provider');
		// Custody of an in-flight message is the own MTA's; a third party may not
		// claim it, and the template must not teach an author to try.
		expect(entry['acceptanceSemantics']).toBeUndefined();
		// The dedup promise needs `buildSystemMailExtras` to carry the key; the
		// template declares the honest `false`, which composition folds to absent.
		expect(entry['deduplicatesOnIdempotencyKey']).not.toBe(true);
	});

	it('declares a per-instance credential, which is what makes instances resolvable', () => {
		// A transport that declared none would keep working on the default instance
		// and be refused `instances_unsupported` for every named one — the template
		// must not scaffold that shape.
		expect(INSTANCE_REQUIRED_ENV.length).toBeGreaterThan(0);
		expect(entry['instanceEnvVars']).toEqual([...INSTANCE_REQUIRED_ENV, ...INSTANCE_OPTIONAL_ENV]);
	});

	it('folds both scopes into the presence list the host asks about', () => {
		for (const name of [...FLAG_ENV.requiredEnvVars, ...INSTANCE_REQUIRED_ENV]) {
			expect(ENTRY_REQUIRED_ENV, `${name} is not in the composed presence list`).toContain(name);
		}
	});

	/**
	 * The two scopes the manifest validator refuses to let overlap: the plugin's
	 * deployment-wide gate is read unsuffixed, the transport's configuration is
	 * read per instance. A template that put the API key in the flag would produce
	 * a transport with no per-instance credential at all.
	 */
	it('keeps the plugin gate and the transport credential in separate scopes', () => {
		expect(FLAG_ENV.requiredEnvVars).toContain(SIGNATURE.secretEnvVar);
		for (const name of [...INSTANCE_REQUIRED_ENV, ...INSTANCE_OPTIONAL_ENV]) {
			expect(FLAG_ENV.requiredEnvVars, `${name} is both a gate and a credential`).not.toContain(
				name
			);
		}
	});
});

/** Every strategy the registry declares, derived — never a list of four names. */
const CONTEXT_FREE_STRATEGIES = Object.keys(SEND_ROUTE_STRATEGIES).filter(
	(strategy) => strategy !== 'adaptive_mix'
) as readonly ProviderRouteConfig['strategy'][];

describe('it is routable, under every declared strategy', () => {
	// A route resolving to nothing falls through to the deployment's
	// `EMAIL_PROVIDER`, which is a real variable for this repository.
	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(CONTEXT_FREE_STRATEGIES.map((strategy) => [strategy] as const))(
		'resolves the scaffolded transport under %s',
		(strategy) => {
			expect(resolveRoute(route({ strategy }), [], configured)).toMatchObject({
				providerType: KIND,
				source: 'org_config',
			});
		}
	);

	// THE MIX: the scaffolded transport is the reference arm on the same terms a
	// core relay is. Both degenerate shares are driven so the case cannot pass by
	// the mix ignoring the share.
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

	it('may serve as the deliverability fallback relay', () => {
		expect(isFallbackRelayEligible(KIND, configured)).toBe(true);
		expect(isFallbackRelayEligible(KIND, () => false)).toBe(false);
	});

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

describe('a send actually goes out through the emitted send module', () => {
	/** The governed entry point's context: authorization recheck + audit sink. */
	function fakeContext(isAuthorized = true) {
		return {
			runMutation: vi.fn(async () => isAuthorized),
			scheduler: { runAfter: vi.fn(async () => undefined) },
		};
	}

	/**
	 * The emitted module's "network". It performs ONE `fetch` and maps the outcome
	 * onto the kit's typed vocabulary, so stubbing the global is what lets this
	 * gate drive the real module rather than a fixture written to be drivable.
	 */
	function stubFetch(response: Partial<Response> & { readonly json?: () => Promise<unknown> }) {
		const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => response as Response);
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	const message = {
		to: 'recipient@example.com',
		from: 'sender@example.com',
		subject: 'Conformance',
		html: '<p>Conformance</p>',
	};

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	/**
	 * NAMED INSTANCES, which is the parity gap D4 opened and P3.1 closed — and the
	 * property a template is most likely to break, because the wrong shape
	 * (`process.env`) also "works" on the default instance.
	 *
	 * The send is addressed to `#eu`, so the emitted module must be handed the
	 * `__EU`-suffixed credential keyed by its BASE name. The assertion reads the
	 * value back off the REQUEST the module made.
	 */
	it("sends on the addressed instance's own credentials", async () => {
		vi.stubEnv('SEND_TRANSPORT_INSTANCES', `${KIND}#eu`);
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		for (const name of INSTANCE_REQUIRED_ENV) vi.stubEnv(`${name}__EU`, 'eu-key');
		const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ id: 'msg-eu-1' }) });

		const context = fakeContext();
		const result = await sendProviderDispatch(context as never, `${KIND}#eu` as never, message);

		// The grant is rechecked on the BARE kind before the module runs: an
		// instance suffix must not smuggle a send past the plugin's authorization.
		expect(context.runMutation).toHaveBeenCalledWith(expect.anything(), {
			pluginId: SCAFFOLDED_PLUGIN_ID,
			providerKind: KIND,
			priorAttempts: 0,
		});
		expect(result).toMatchObject({
			providerType: KIND,
			transportId: `${KIND}#eu`,
			attempts: 1,
			result: { success: true, id: 'msg-eu-1' },
		});
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(JSON.stringify(init?.headers)).toContain('eu-key');
		expect(JSON.stringify(init?.headers)).not.toContain(DEFAULT_CREDENTIAL);
	});

	it('sends on the deployment-default instance for the bare kind', async () => {
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		for (const name of INSTANCE_REQUIRED_ENV) vi.stubEnv(`${name}__EU`, 'eu-key');
		const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ id: 'msg-1' }) });

		await sendProviderDispatch(fakeContext() as never, KIND, message);

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(JSON.stringify(init?.headers)).toContain(DEFAULT_CREDENTIAL);
	});

	/**
	 * FAIL CLOSED BEFORE THE MODULE RUNS. The error CODE is asserted, not just the
	 * failure: `success: false` with no request made is also what a THROW looks
	 * like, so a bare assertion would stay green while the operator-facing failure
	 * stopped being attributable to credentials.
	 */
	it('never calls the module when a required credential is unset', async () => {
		for (const name of FLAG_ENV.requiredEnvVars) vi.stubEnv(name, 'set');
		vi.stubEnv(SIGNATURE.secretEnvVar, 'whsec-scaffolded');
		const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ id: 'nope' }) });

		const result = await sendProviderDispatch(fakeContext() as never, KIND, message);

		expect(result.result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AUTH_FAILED,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('never calls the module when the capability grant is refused', async () => {
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ id: 'nope' }) });

		const result = await sendProviderDispatch(fakeContext(false) as never, KIND, message);

		expect(result.result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AUTH_FAILED,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	/**
	 * THE RETRY SEMANTICS THE TEMPLATE SHIPS. This is the part of a provider
	 * integration that is the same for every vendor and the part an author is most
	 * likely to get wrong, so the emitted mapping is pinned at the GOVERNED
	 * boundary: a 429 must come back retryable and a 400 must not.
	 */
	it.each([
		// A rate limit is retryable, so the loop spends the entry's whole
		// `retryDelays` budget: one attempt per delay plus the first.
		[429, EmailErrorCode.RATE_LIMIT, (entry['retryDelays'] as readonly number[]).length + 1],
		// A rejection is terminal: retrying it would burn the budget on a send that
		// can never succeed.
		[400, EmailErrorCode.CONTENT_REJECTED, 1],
	])('maps a provider %s onto the host vocabulary', async (status, errorCode, attempts) => {
		for (const [key, value] of Object.entries(CONFIGURED)) vi.stubEnv(key, value);
		stubFetch({ ok: false, status });

		const result = await sendProviderDispatch(fakeContext() as never, KIND, message);

		expect(result.result).toMatchObject({ success: false, errorCode });
		expect(result.attempts).toBe(attempts);
	});
});

describe('it is a reference arm and its return-path posture is honest', () => {
	it('files sends on the reference arm, and the own MTA on the own arm', () => {
		expect(armForTransport(KIND)).toBe('reference');
		expect(armForTransport(OWN)).toBe('own');
	});

	it('is never probed, and grades degraded from its declaration alone', () => {
		expect(isProbeDecidedReturnPathKind(KIND)).toBe(false);
		const resolved = resolveReturnPathCapability(KIND, null, Date.now());
		expect(resolved).toMatchObject({
			capability: 'unsupported',
			declared: 'no',
			reason: 'declared_unsupported',
		});
		expect(measurementQualityOf(resolved)).toBe('degraded');
	});
});

describe('its feedback arrives on the plugin webhook route', () => {
	const NOW = Date.now();
	/**
	 * The wire shape the EMITTED webhook module parses, written from its own
	 * declared event kinds rather than from a copy: an author who renames
	 * `hard_bounce` renames it in one place and this body follows.
	 */
	const BODY = JSON.stringify({
		events: [
			{ type: 'delivered', message_id: 'm1', timestamp: NOW - 4, recipient: 'a@example.com' },
			{ type: 'hard_bounce', message_id: 'm2', timestamp: NOW - 3, reason: '550 no such user' },
			{ type: 'complaint', timestamp: NOW - 2, recipient: 'c@example.com' },
			{ type: 'deferred', message_id: 'm4', timestamp: NOW - 1, reason: '451 try later' },
			{ type: 'opened', message_id: 'm5', timestamp: NOW },
		],
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('registers exactly this plugin id, and nothing else', () => {
		expect(pluginSendTransportWebhookFor(SCAFFOLDED_PLUGIN_ID)?.definition).toMatchObject({
			kind: KIND,
			pluginId: SCAFFOLDED_PLUGIN_ID,
			storeRawPayload: false,
		});
		expect(pluginSendTransportWebhookFor('someone-else')).toBeUndefined();
		expect(pluginSendTransportWebhookFor('__proto__')).toBeUndefined();
	});

	/**
	 * THE REPLAY PROVISIONS THE HOST REQUIRES, carried from the emitted manifest
	 * through codegen. A template that shipped a body-only HMAC would scaffold a
	 * package that fails validation; one that shipped an unbounded tolerance would
	 * scaffold an endpoint a captured request verifies against forever.
	 */
	it('carries a bounded, replay-bound signature contract', () => {
		expect(SIGNATURE.algorithm).toBe('hmac-sha256');
		expect(SIGNATURE.replay.timestampHeader.length).toBeGreaterThan(0);
		expect(SIGNATURE.replay.toleranceSeconds).toBeGreaterThan(0);
		expect(SIGNATURE.replay.toleranceSeconds).toBeLessThanOrEqual(900);
	});

	// The whole chain: the host proves authenticity, the emitted module turns
	// verified bytes into feedback facts, and the host re-validates that output and
	// stamps the transport kind itself.
	it('verifies, parses and revalidates a signed batch into four feedback facts', async () => {
		vi.stubEnv(SIGNATURE.secretEnvVar, CONFIGURED[SIGNATURE.secretEnvVar]!);
		const surface = pluginSendTransportWebhookFor(SCAFFOLDED_PLUGIN_ID);
		if (!surface) throw new Error('the scaffolded webhook is not registered');

		const timestamp = String(Math.floor(NOW / 1000));
		const verified = await verifyPluginReplayBoundSignature({
			contract: surface.definition.signature,
			pluginId: SCAFFOLDED_PLUGIN_ID,
			transportKind: KIND,
			rawBody: BODY,
			signature: createHmac('sha256', CONFIGURED[SIGNATURE.secretEnvVar]!)
				.update(`${timestamp}.${BODY}`)
				.digest('hex'),
			timestamp,
			nowMs: NOW,
		});
		expect(verified.ok).toBe(true);

		const events = parsePluginFeedbackEvents(
			surface.module.parseEvents(BODY),
			surface.definition.kind
		);
		expect(events.map((event) => event.kind)).toEqual([
			'email.delivered',
			'email.bounced',
			'email.complained',
			'email.deferred',
		]);
		expect(
			events.every(
				(event) =>
					'providerType' in event &&
					(event as { readonly providerType?: string }).providerType === KIND
			)
		).toBe(true);
	});
});

describe('it proves a sending domain through the emitted identity module', () => {
	const config = {
		instanceKey: null,
		env: Object.fromEntries(INSTANCE_REQUIRED_ENV.map((name) => [name, DEFAULT_CREDENTIAL])),
	};

	function identityModule() {
		const surface = pluginSendTransportDomainIdentityFor(KIND);
		if (!surface) throw new Error('the scaffolded domain identity is not registered');
		return surface.module;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is registered as a sending-domain identity provider for its own kind', () => {
		expect(pluginSendTransportDomainIdentityFor(KIND)?.definition).toMatchObject({
			kind: KIND,
			pluginId: SCAFFOLDED_PLUGIN_ID,
			requiredEnvVars: INSTANCE_REQUIRED_ENV,
		});
	});

	// THE SPLIT: the module reports observations, the HOST derives the status.
	it('derives verified from the observations the module reported', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ verified: true, spf_valid: true, dkim_valid: true }),
			}))
		);
		const outcome = parsePluginRelayResult(
			await identityModule().registerDomain('sender.example.com', config)
		);
		expect(outcome.outcome).toBe('ok');
		expect(outcome.outcome === 'ok' ? outcome.observation.status : null).toBe('verified');
		// A selector list is what the ramp's alignment pre-flight resolves; an empty
		// one would hold every domain at s=0, so the template must ship a real one.
		expect(outcome.outcome === 'ok' ? outcome.observation.dkimSelectors.length : 0).toBeGreaterThan(
			0
		);
	});

	it('reports a domain whose DNS is not published as unverified, never verified', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ verified: true, spf_valid: true, dkim_valid: false }),
			}))
		);
		const outcome = parsePluginRelayResult(
			await identityModule().checkDomain('pending.example.com', config)
		);
		expect(outcome.outcome === 'ok' ? outcome.observation.status : null).not.toBe('verified');
	});

	it('distinguishes a rejected credential from an outage', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 401 }))
		);
		expect(
			parsePluginRelayResult(await identityModule().checkDomain('a.example.com', config)).outcome
		).toBe('auth_failed');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 503 }))
		);
		expect(
			parsePluginRelayResult(await identityModule().checkDomain('a.example.com', config)).outcome
		).toBe('unavailable');
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
	 * THE JOIN THAT MAKES A FORM HONEST: every variable the form writes is one the
	 * transport reads, in the list matching the field's own `required`. A form
	 * asking for a variable no send reads is an operator filling in nothing; one
	 * omitting a gating variable is a transport that stays unconfigured behind a
	 * complete-looking form.
	 */
	it('asks only for variables this transport reads, in the matching list', () => {
		const required = new Set(INSTANCE_REQUIRED_ENV);
		const optional = new Set(INSTANCE_OPTIONAL_ENV);
		for (const field of fields) {
			const envVar = field['envVar'] as string;
			expect(field['required'] === true ? required.has(envVar) : optional.has(envVar)).toBe(true);
		}
		// Every required variable is askable, or an operator cannot configure the
		// transport from the form at all.
		for (const name of INSTANCE_REQUIRED_ENV) {
			expect(fields.some((field) => field['envVar'] === name)).toBe(true);
		}
	});

	it('marks the credential itself write-only', () => {
		const secret = fields.find((field) => field['envVar'] === INSTANCE_REQUIRED_ENV[0]);
		expect(secret).toMatchObject({ kind: 'secret', required: true });
	});
});

describe('none of it required an edit', () => {
	/**
	 * THE HEADLINE CLAIM, ASSERTED. Everything above ran against files this suite
	 * did not write by hand — but "did not write by hand" is only worth the
	 * assertion if the materialised directory still holds exactly what the
	 * generator produced. The fixture writes `buildScaffold`'s output and keeps the
	 * map; this reads every file back off disk and compares it byte for byte, so a
	 * fixture that patched a TODO to make a case pass fails here.
	 */
	it('drove the generator output byte for byte, with nothing patched', async () => {
		const { readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		expect(bundle.files.size).toBeGreaterThan(0);
		for (const [path, content] of bundle.files) {
			const onDisk = await readFile(join(bundle.directory, ...path.split('/')), 'utf8');
			expect(onDisk, `${path} differs from what the generator emitted`).toBe(content);
		}
	});

	/**
	 * And no production file knows this bundle exists. The scaffolded package is
	 * written to a temporary directory and named after a stranger's scope, so a
	 * hit under `apps/` or `packages/` would mean a core module had been taught
	 * about it — the one thing D4's policy forbids.
	 *
	 * ONE TEST FILE IS EXEMPT AND NAMED: the generator's own suite scaffolds under
	 * the same identity, which is deliberate — it is the same fixture, and binding
	 * the two means renaming it in one place fails in the other rather than leaving
	 * a generator suite and a conformance gate measuring different packages.
	 */
	const ALLOWED_TEST_FILES = [
		// The generator's own suite scaffolds under the same identity — the same
		// fixture, deliberately, so renaming it in one place fails in the other.
		'packages/plugin-cli/src/__tests__/scaffoldSendProvider.test.ts',
		// The compiled manifest sample the guide quotes verbatim, which declares the
		// same id the guide's `create` command scaffolds. A sample declaring a
		// different one would show a reader a manifest that is not the one the
		// command they just ran produced.
		'packages/plugin-kit/src/__tests__/docsSamples.test.ts',
	].sort();

	/**
	 * PROSE IS EXCLUDED, and only prose. The authoring guide tells an author to run
	 * `create` under exactly this identity, which is the point rather than a leak —
	 * a documented command nothing exercises is how a scaffold rots. The binding
	 * between the two is asserted in its own case below rather than being lost in
	 * an exemption list.
	 */
	const PROSE = ':(exclude)*.md';

	it('leaves every non-test source file under apps/ and packages/ ignorant of it', async () => {
		const { execFileSync } = await import('node:child_process');
		const { REPOSITORY_ROOT } = await import('../repository');
		// `git grep` exits 1 when it matches nothing, which is the EXPECTED outcome
		// here — so the empty result is read off the exit status rather than thrown.
		// Anything else (a bad pathspec, no repository) still propagates.
		let hits: string[] = [];
		try {
			hits = execFileSync(
				'git',
				[
					'grep',
					'-lI',
					'--untracked',
					'-e',
					SCAFFOLDED_PACKAGE_NAME,
					'-e',
					`plugin.${SCAFFOLDED_PLUGIN_ID}.relay`,
					'--',
					'apps',
					'packages',
					PROSE,
				],
				{ cwd: REPOSITORY_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
			)
				.split('\n')
				.filter((line) => line.length > 0);
		} catch (error) {
			if ((error as { status?: number }).status !== 1) throw error;
		}
		expect(hits.filter((path) => !path.includes('/__tests__/'))).toEqual([]);
		expect([...hits].sort()).toEqual(ALLOWED_TEST_FILES);
	});

	/**
	 * THE COMMAND THE GUIDE PRINTS IS THE COMMAND THIS GATE PROVES.
	 *
	 * The authoring page opens with an `owlat plugins create` invocation, and a
	 * reader will run it verbatim. Binding it here means the identity this suite
	 * drives through routing, dispatch, feedback and identity is the identity that
	 * invocation produces — so a guide edited to show a different id or package
	 * fails rather than shipping a command nothing has exercised.
	 */
	it('is the identity the authoring guide tells an author to scaffold', async () => {
		const { readFileSync } = await import('node:fs');
		const { resolve } = await import('node:path');
		const { REPOSITORY_ROOT } = await import('../repository');
		const guide = readFileSync(
			resolve(REPOSITORY_ROOT, 'apps/docs/content/3.developer/49.plugin-send-providers.md'),
			'utf8'
		);
		const command = /owlat plugins create ([\w-]+) --name (\S+) --template (\S+)/.exec(guide);
		expect(command, 'the guide no longer prints a create invocation').not.toBeNull();
		expect(command![1]).toBe(SCAFFOLDED_PLUGIN_ID);
		expect(command![2]).toBe(SCAFFOLDED_PACKAGE_NAME);
		expect(command![3]).toBe('send-provider');
	});
});
