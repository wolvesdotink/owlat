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
 * MOST OF THAT LIST IS NOT WRITTEN OUT BELOW, and that is the point. Those rules
 * are the HOST's, not this fixture's, and P3.4's scaffold gate has to hold a
 * second subject to exactly the same ones — so they live once, in
 * `../sendProviderConformance.ts`, and both suites run that body against their
 * own composed artifact. A second copy would be a second place to edit when
 * `resolveRoute` grows an argument, and a copy that is only edited in one place
 * silently stops measuring what it claims to.
 *
 * WHAT REMAINS HERE IS THE FIXTURE'S OWN: the recorded attempt log the dispatch
 * cases read (the scaffolded subject has a stubbed `fetch` instead), the exact
 * wire values its manifest declares, the author-prose round trip, and the
 * bindings to the hand-written copies of this fixture that
 * live in other packages.
 *
 * THE CREDENTIALS UI OBLIGATION is closed at its owning surface by
 * `apps/web/app/composables/__tests__/pluginTransportCredentials.test.ts`. Plugin
 * codegen emits the same catalog data into web and API, so the picker, renderer,
 * required-field gate, env patch and server allowlist all consume the composed
 * descriptor without learning this fixture's name.
 *
 * RETURN-PATH PROBES (plan §5's P3.3 obligation list) are SUPERSEDED, not a
 *      gap. P3.1 gave this tier `supportsCustomReturnPath: 'no'` as its only
 *      value, because the VERP local part a probe would measure is signed with a
 *      deployment secret a third-party module is never handed. So a plugin kind
 *      is unprobeable BY CONSTRUCTION and the obligation is discharged in the
 *      form the shipped contract allows: the fold READS the declaration, and the
 *      probe sweep excludes the kind. A4 (§8) does not list probes, which is the
 *      reading this suite follows; §5's line predates P3.1. The cost is recorded
 *      rather than hidden — the shared body's "is never probed, and grades
 *      degraded from its declaration alone" asserts the permanent `degraded`
 *      measurement quality that follows from it, for both subjects.
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
 * last block reads that file back to pin every datum of its hand-written copies —
 * the entry's and the roster's — to the value this composition actually produces.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPOSITORY_ROOT, repositoryFilesMentioning } from '../repository';
import {
	MOCK_ESP_KIND,
	MOCK_ESP_PACKAGE_NAME,
	MOCK_ESP_PLUGIN_ID,
	MOCK_ESP_SIGNATURE_HEADER,
	MOCK_ESP_TIMESTAMP_HEADER,
	MOCK_ESP_TOLERANCE_SECONDS,
	mockEspPlugin,
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

import { type SendProviderKind } from '@owlat/api/sendProviders/catalog';
import { buildDispatchExtrasFor } from '@owlat/api/sendProviders/registry';
import { sendProviderDispatch } from '@owlat/api/sendProviders/dispatch';
import { pluginSendTransportWebhookFor } from '@owlat/api/plugins/sendTransportWebhookCatalog';
import { pluginSendTransportDomainIdentityFor } from '@owlat/api/plugins/sendTransportDomainIdentityCatalog';
import { parsePluginRelayResult } from '@owlat/api/domains/pluginRelayState';
import { coreSendProviderCatalogEntry } from '@owlat/shared/sendProviderCatalog';
import { describeSendProviderConformance } from '../sendProviderConformance';
import { mockEspComposition } from '../fixtures/mockEsp/composition';

const KIND = MOCK_ESP_KIND as SendProviderKind;

/** Everything the fixture's credentials would be set to on a real deployment. */
const CONFIGURED: Readonly<Record<string, string>> = Object.freeze({
	[MOCK_ESP_ENABLED_ENV]: 'true',
	[MOCK_ESP_WEBHOOK_SECRET_ENV]: 'whsec-mock-esp',
	[MOCK_ESP_TOKEN_ENV]: 'tok-live',
});

/**
 * The fixture's wire shape for one signed delivery.
 *
 * RELATIVE to the run, because the host bounds an event's timestamp against the
 * wall clock (a year back, a day forward) before it will record it — a fixed
 * epoch would have this suite start failing on a date rather than on a
 * regression. The last event is a kind this integration does not consume, and it
 * carries no timestamp: it must be acknowledged rather than 400-ed, which would
 * make the provider redeliver the whole batch forever.
 */
const NOW = Date.now();
const FEEDBACK_BODY = JSON.stringify({
	events: [
		{ type: 'accepted', id: 'msg-1', ts: NOW - 4, email: 'a@example.com' },
		{ type: 'hard_bounce', id: 'msg-2', ts: NOW - 3, detail: '550 no such user' },
		{ type: 'spam_report', ts: NOW - 2, email: 'c@example.com' },
		{ type: 'deferral', id: 'msg-4', ts: NOW - 1, detail: '451 try later' },
		{ type: 'opened', id: 'msg-5' },
	],
});

/**
 * THE HOST'S RULES, RUN AGAINST THE FIXTURE'S COMPOSED ARTIFACT.
 *
 * Routing under every declared strategy, the fallback arm and its per-domain
 * proof gate, arm attribution, the return-path fold, the feedback route's
 * registration and re-validation, the derived domain status and the credential
 * vocabulary all live in `../sendProviderConformance.ts` and are run identically
 * against P3.4's scaffolded bundle. Everything below this call is what only THIS
 * fixture can be asked.
 *
 * The identity scenarios are the fixture's imagined provider rule, stated in one
 * place: a registered domain is fully observed, `pending.*` has not published its
 * DKIM, and an instance with no token is refused.
 */
describeSendProviderConformance({
	kind: KIND,
	pluginId: MOCK_ESP_PLUGIN_ID,
	entry: mockEspComposition().sendTransports[0]! as Record<string, unknown>,
	instanceRequiredEnv: [MOCK_ESP_TOKEN_ENV],
	instanceOptionalEnv: [MOCK_ESP_REGION_ENV],
	flagRequiredEnv: [MOCK_ESP_ENABLED_ENV, MOCK_ESP_WEBHOOK_SECRET_ENV],
	signature: {
		header: MOCK_ESP_SIGNATURE_HEADER,
		algorithm: 'hmac-sha256',
		encoding: 'hex',
		secretEnvVar: MOCK_ESP_WEBHOOK_SECRET_ENV,
		replay: {
			timestampHeader: MOCK_ESP_TIMESTAMP_HEADER,
			toleranceSeconds: MOCK_ESP_TOLERANCE_SECONDS,
		},
	},
	webhookSecretValue: CONFIGURED[MOCK_ESP_WEBHOOK_SECRET_ENV]!,
	// THIS FIXTURE'S "NETWORK": a module-level attempt log rather than a stubbed
	// `fetch`. The shared body never learns which — it arranges, dispatches and
	// reads back the two values the host decided (which instance's credential and
	// which instance's optional value reached the module).
	send: {
		arrange: () => {
			resetMockEspAttempts();
		},
		attempts: () =>
			mockEspAttempts().map((attempt) => ({
				credential: attempt.token,
				optional: attempt.region,
			})),
	},
	feedbackBatch: {
		body: FEEDBACK_BODY,
		kinds: ['email.delivered', 'email.bounced', 'email.complained', 'email.deferred'],
	},
	domainScenarios: {
		verified: () => ({
			domain: 'sender.example.com',
			config: { instanceKey: null, env: { [MOCK_ESP_TOKEN_ENV]: 'tok-live' } },
		}),
		unverified: () => ({
			domain: 'pending.example.com',
			config: { instanceKey: null, env: { [MOCK_ESP_TOKEN_ENV]: 'tok-live' } },
		}),
		authFailed: () => ({ domain: 'sender.example.com', config: { instanceKey: 'eu', env: {} } }),
	},
});

describe('the bundle composes to the exact kind its host fixtures spell', () => {
	// THE LITERAL, spelled once. The fixture BUILDS its kind through the grammar's
	// single builder (the rule `namespacedKindGrammar.test.ts` owns), so nothing
	// here re-checks the grammar — what this pins is the resulting string, because
	// host fixtures outside this package spell it by hand across the API, web and
	// shared packages. Renaming the plugin id or the transport's local id has to
	// fail HERE, where the rename is visible, rather than leaving those fixtures
	// measuring a kind nothing composes.
	it('composes to the exact kind the out-of-package fixtures spell', () => {
		expect(MOCK_ESP_KIND).toBe('plugin.mock-esp.relay');
	});
});

describe('a send actually goes out through the plugin module', () => {
	/*
	 * INSTANCE RESOLUTION AND THE TWO FAIL-CLOSED REFUSALS ARE NOT HERE. They are
	 * the HOST's rules, they were written twice — once per subject — and the only
	 * thing that differed was how each subject's network is arranged and read back.
	 * They now live in `../sendProviderConformance`, driven through the `send`
	 * harness this file supplies above, and run identically over P3.4's scaffolded
	 * bundle. What is left below is the one dispatch fact only THIS fixture can be
	 * asked: the extras seam, whose value shape is the fixture's own.
	 */

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

	// The fixture's attempt log is module state, so it is cleared by a HOOK rather
	// than by a line each case has to remember: a case added below without that line
	// would read the previous case's attempt and fail — or, under `toMatchObject`,
	// pass — for a reason unrelated to what it tests.
	beforeEach(() => {
		resetMockEspAttempts();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	/**
	 * THE EXTRAS SEAM, driven end to end — the half of the bundle every dispatch
	 * case in the shared body sees as `extras: {}`.
	 *
	 * `buildDispatchExtrasFor` is the governed boundary's ONE question ("module,
	 * what do you make of this send?"), and it asks both tiers identically. The
	 * chain here is the production one in full: the host's registry finds the
	 * hosted adapter's wrapper, the wrapper narrows `DispatchExtrasInput` to the
	 * facts a third party may see, the PLUGIN's builder turns those into its own
	 * shape, and the value comes back through `parseExtras` at the adapter's
	 * untrusted-input boundary before the module's `send` is handed it.
	 *
	 * It stays with this fixture because the SHAPE it asserts is the fixture's own
	 * (`{ campaignTag }` built from the message type), and because reading it back
	 * needs the fixture's recorded attempt rather than the two values the shared
	 * harness reports. Without it, a codegen or host change that stopped wiring
	 * `buildDispatchExtras` onto the hosted adapter would leave every case in this
	 * file green — the bundle would simply lose a declared half in silence.
	 */
	it("carries the plugin's own extras from the governed boundary into its send", async () => {
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

describe('its feedback route carries the contract this manifest declared', () => {
	/*
	 * THE CHAIN IS NOT HERE. Host verification → plugin parse → host revalidation,
	 * the registration by plugin id and the `__proto__` probe are the HOST's rules
	 * and live in `../sendProviderConformance.ts`, which runs them over the batch
	 * this file declares above (`FEEDBACK_BODY`) and over the scaffolded subject's.
	 *
	 * The verifier's negatives are not here either, and never were: tampered body,
	 * forged signature, replay outside the window, a tolerance beyond the kit's
	 * ceiling and the 503 an unset secret answers are
	 * `verifyPluginReplayBoundSignature`'s own contract, owned exhaustively by
	 * `apps/api/convex/plugins/__tests__/inboundSignature.test.ts` at the verifier
	 * and `apps/api/convex/webhooks/__tests__/pluginFeedbackRoute.test.ts` at the
	 * route.
	 *
	 * What is left is the one thing only this fixture can be asked: that the exact
	 * contract its manifest wrote survived codegen unaltered. The shared body checks
	 * the SHAPE (an HMAC family, a bounded replay window); this checks the VALUES.
	 */
	it('verifies with the declared contract, value for value', () => {
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

	/**
	 * BOTH HALVES OF THE TIMESTAMP RULE, because only one of them is visible in the
	 * batch above.
	 *
	 * `FEEDBACK_BODY`'s last event is a kind this integration does not consume and
	 * carries no `ts`: it must be ACKNOWLEDGED, or a provider redelivers the whole
	 * batch forever and the four facts beside it never land. That is what the shared
	 * body's chain case exercises. The other half is what keeps the first from being
	 * a licence to accept anything — an event this integration DOES consume, with no
	 * usable time, is a fact the host cannot place on any timeline and the module
	 * refuses it rather than inventing `Date.now()`.
	 *
	 * Through the registry lookup, like every other module call in this package: a
	 * registration answering this plugin id with somebody else's parser would
	 * otherwise pass.
	 */
	it('still refuses a consumed event that carries no timestamp', () => {
		const surface = pluginSendTransportWebhookFor(MOCK_ESP_PLUGIN_ID);
		if (!surface) throw new Error('the fixture webhook is not registered');
		const untimed = JSON.stringify({ events: [{ type: 'accepted', id: 'msg-9' }] });
		expect(() => surface.module.parseEvents(untimed)).toThrow(TypeError);
	});
});

describe("its identity module reports this provider's own observations", () => {
	/*
	 * THE HOST'S HALF IS NOT HERE. That the registry is keyed by NAMESPACED KIND,
	 * that the host derives `verified` from observations, that a rejected credential
	 * is `auth_failed` rather than an outage and that an unrecognised shape is
	 * `unavailable` are the host's rules, run over this fixture and over the
	 * scaffolded one by `../sendProviderConformance.ts`.
	 *
	 * What only this fixture can be asked is what its imagined provider SEES — the
	 * selector and mechanism it signs under, the `pending_dns` state a domain
	 * registered but not published sits in, and that `registerDomain` is the half
	 * that actually WRITES.
	 */
	const config = { instanceKey: null, env: { [MOCK_ESP_TOKEN_ENV]: 'tok-live' } };

	// The registration log is module state, cleared by a hook for the reason the
	// dispatch block's is: a later case that read it without remembering the line
	// would be asserting against an earlier case's registration.
	beforeEach(() => {
		resetMockEspRegisteredDomains();
	});

	/** Resolved the way the host resolves it, not through the fixture import. */
	function identityModule() {
		const surface = pluginSendTransportDomainIdentityFor(MOCK_ESP_KIND);
		if (!surface) throw new Error('the fixture domain identity is not registered');
		return surface.module;
	}

	it('reports the selector and mechanism it signs under, and WRITES on register', async () => {
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

	// The two NOT-verified states the host distinguishes, which need a provider that
	// can report both: a domain it knows about whose DNS is not published yet, and
	// one it has never heard of.
	it.each([
		['pending.example.com', 'pending_dns'],
		['unknown.example.com', 'unverified'],
	])('derives %s as %s', async (domain, status) => {
		const outcome = parsePluginRelayResult(await identityModule().checkDomain(domain, config));
		expect(outcome.outcome === 'ok' ? outcome.observation.status : null).toBe(status);
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

	// THE VOCABULARY MEMBERSHIP AND THE REQUIRED/OPTIONAL JOIN ARE THE HOST'S, and
	// live in `../sendProviderConformance.ts`. What is this fixture's is WHICH two
	// drawings it exercises: the masked one and a closed set, so both branches a
	// renderer has are covered by at least one subject.
	it('exercises both drawings the renderer has', () => {
		expect(fields).toBeDefined();
		expect((fields ?? []).map((field) => field['kind'])).toEqual(['secret', 'select']);
	});

	/**
	 * THE AUTHOR'S PROSE, VERBATIM — the half of a form a renderer shows and no
	 * other case reads.
	 *
	 * It is also the only assertion that can catch this package's artifact reader
	 * looking INSIDE a string value. The manifest's two descriptions deliberately
	 * contain the semicolon a reader must not truncate at, the words `import` and
	 * `require` its data-only guard scans for, and the ` as const` it strips as the
	 * artifact's one piece of TypeScript. A reader that read code and prose alike
	 * would either refuse this bundle outright or hand back a description the
	 * manifest never wrote — and every other case here would still pass.
	 */
	it("carries the author's labels and descriptions into the entry unaltered", () => {
		const declared = mockEspPlugin.contributes.sendTransports[0].credentialFields;
		expect((fields ?? []).map((field) => [field['label'], field['description']])).toEqual(
			declared.map((field) => [field.label, field.description])
		);
		// The characters that make this case worth having, named rather than implied.
		expect(declared[0].description).toContain(';');
		expect(declared[0].description).toMatch(/\bimport\b/);
		expect(declared[0].description).toMatch(/\brequire\b/);
		expect(declared[1].description).toMatch(/\s+as const\b/);
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
	 * THE COMPOSITION BOUNDARY, STATED WHERE ITS ARCHITECTURE IS.
	 *
	 * Everything above is the PLUGIN's half of D5 and it is complete: the bundle
	 * ships a form in the vocabulary `TransportCredentialFields.vue` draws, joined
	 * to the variables its sends read. Shared deliberately stays core-only; plugin
	 * codegen now emits the same composed data-only catalog into web and API, so
	 * each package gets the concrete build without importing through the other.
	 *
	 * THE BEHAVIOURAL PIN IS AT THE WEB SURFACE, not here:
	 * `apps/web/app/composables/__tests__/pluginTransportCredentials.test.ts`
	 * drives `credentialFieldsFor` / `seedCredentialValues` /
	 * `transportCredentialEnv` — the three functions the wizard and the editor
	 * actually call. This case asserts the complementary architectural fact that
	 * shared itself still does not absorb a concrete plugin build.
	 */
	it('leaves the shared catalog core-only', () => {
		// The composed half is asserted by the shared body ("is served by the shipped
		// catalog as the entry composition produced"); what this adds is the other
		// side of the package boundary — shared does not answer for this kind.
		expect(coreSendProviderCatalogEntry(MOCK_ESP_KIND)).toBeUndefined();
	});
});

describe('none of it required a core edit', () => {
	/**
	 * THE HEADLINE CLAIM, ASSERTED. Everything above runs against shipped modules;
	 * this checks that no PRODUCTION file learned the fixture exists.
	 *
	 * Five test files under `apps/` / `packages/` are exempt and named, because they prove
	 * parts of this proof that cannot live in this package: the ramp fixture needs a
	 * Convex database, while the credential and artifact guards need `apps/web`'s own
	 * module graph. `--untracked` so a file added in this working tree counts.
	 */
	const RAMP_FIXTURE = 'apps/api/convex/delivery/ramp/__tests__/pluginReferenceArm.test.ts';
	const WEB_CREDENTIAL_PROOF =
		'apps/web/app/composables/__tests__/pluginTransportCredentials.test.ts';
	const WEB_CATALOG_GUARD_PROOF =
		'apps/web/app/utils/__tests__/composedSendProviderCatalog.test.ts';
	const WEB_SERVER_ALLOWLIST_PROOF =
		'apps/web/server/api/delivery/__tests__/apply-transport.test.ts';
	const SHARED_ENV_PLAN_PROOF = 'packages/shared/src/__tests__/transportEnvPlan.test.ts';

	it('leaves every non-test file under apps/ and packages/ ignorant of the fixture', () => {
		// The search itself lives in `../repository`, because the scaffold gate makes
		// the same claim about its own subject with the same flags and the same
		// treatment of the empty result — and a change to either that landed in one
		// copy would leave the other measuring something else.
		const hits = repositoryFilesMentioning([MOCK_ESP_PLUGIN_ID, MOCK_ESP_PACKAGE_NAME]);

		expect(hits.filter((path) => !path.includes('/__tests__/'))).toEqual([]);
		// And the five test files that ARE allowed to know.
		expect([...hits].sort()).toEqual(
			[
				RAMP_FIXTURE,
				WEB_CREDENTIAL_PROOF,
				WEB_CATALOG_GUARD_PROOF,
				WEB_SERVER_ALLOWLIST_PROOF,
				SHARED_ENV_PLAN_PROOF,
			].sort()
		);
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
	 * The ramp fixture restates MORE than the kind — it hand-writes a narrowed copy
	 * of the composed entry and of the roster — and the two cases below bind every
	 * datum in that copy rather than a chosen subset of it, so "the mock is what
	 * composition produces" is checked rather than asserted in a comment.
	 */
	it.each([
		[RAMP_FIXTURE],
		[WEB_CREDENTIAL_PROOF],
		[WEB_CATALOG_GUARD_PROOF],
		[WEB_SERVER_ALLOWLIST_PROOF],
		[SHARED_ENV_PLAN_PROOF],
	])('binds %s to the composed kind', (path) => {
		const source = readFileSync(resolve(REPOSITORY_ROOT, path), 'utf8');
		expect(source).toContain(MOCK_ESP_KIND);
	});

	/**
	 * A composed value, as a source-text pattern tolerant of the formatter.
	 *
	 * The property name is anchored at its start (`id` must not be satisfied by a
	 * `pluginId` elsewhere in the file) and the value is escaped, because a composed
	 * kind carries dots.
	 */
	function spelled(property: string, value: string): RegExp {
		return new RegExp(
			`(?<![$\\w])${property}:\\s*'${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`
		);
	}

	/**
	 * EVERY DATUM THE RAMP FIXTURE'S NARROWED ENTRY CARRIES, bound to the value
	 * composition actually produces.
	 *
	 * The configuration lists are the obvious half: a renderer that stopped folding
	 * the flag's `requiredEnvVars` into the entry, or that stopped composing
	 * `instanceEnvVars` from the required and optional lists, moves one of them. The
	 * CAPABILITY half matters just as much and is easier to miss — the mock's
	 * `supportsCustomReturnPath` and `messageIdSource` exist to satisfy the load-time
	 * guards `lib/sendProviders/catalog.ts` runs on import
	 * (`assertPluginReturnPathClaimsAreHonest`, `assertPluginDispatchSemanticsAreGeneral`),
	 * so an unbound copy would go on satisfying them with a value the bundle no
	 * longer declares while both suites stayed green.
	 *
	 * The credential fields are checked as a UNIT rather than as loose strings: the
	 * envVar alone is already carried by `instanceEnvVars`, and what the guards read
	 * is the pairing — this field, of this kind, required or not.
	 */
	it("binds the ramp fixture to every value of the composed entry's narrowed copy", () => {
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

		for (const property of ['pluginId', 'supportsCustomReturnPath', 'messageIdSource'] as const) {
			const value = entry[property] as string;
			expect(value, `the composition no longer carries ${property}`).toBeTypeOf('string');
			expect(source, `the ramp fixture no longer spells ${property}: '${value}'`).toMatch(
				spelled(property, value)
			);
		}

		const fields = entry['credentialFields'] as readonly Record<string, unknown>[];
		expect(fields.length).toBeGreaterThan(0);
		for (const field of fields) {
			const envVar = field['envVar'] as string;
			// The one object literal in the ramp fixture that names this variable —
			// brace-bounded, so `kind` and `required` below are read off THIS field
			// rather than off whichever one happened to be nearest in the text.
			const literal = source.match(new RegExp(`\\{[^{}]*envVar:\\s*'${envVar}'[^{}]*\\}`));
			expect(literal, `the ramp fixture has no credential field for ${envVar}`).not.toBeNull();
			expect(literal![0], `${envVar} is no longer a ${field['kind'] as string} field`).toMatch(
				spelled('kind', field['kind'] as string)
			);
			// Required-ness both ways: a field the bundle does not require must not be
			// spelled required in the copy either.
			expect(/required:\s*true/.test(literal![0]), `${envVar} required-ness drifted`).toBe(
				field['required'] === true
			);
		}
	});

	/**
	 * AND THE ROSTER'S NARROWED COPY — the second mocked artifact, which the
	 * operator's door reads to resolve the plugin's flag and capability grant.
	 *
	 * Same argument, different artifact: a manifest that dropped `send:transport`,
	 * renamed the package or moved a variable out of the flag's list would leave the
	 * ramp suite granting and configuring something the bundle no longer declares.
	 */
	it("binds the ramp fixture to the composed roster's narrowed copy", () => {
		const source = readFileSync(resolve(REPOSITORY_ROOT, RAMP_FIXTURE), 'utf8');
		const plugin = mockEspComposition().roster[0]! as unknown as Record<string, unknown>;
		const manifest = plugin['manifest'] as Record<string, unknown>;
		const flag = manifest['flag'] as Record<string, unknown>;

		expect(source).toContain(plugin['packageName'] as string);
		expect(source).toMatch(spelled('id', manifest['id'] as string));
		expect(source).toMatch(spelled('version', manifest['version'] as string));
		for (const capability of manifest['capabilities'] as readonly string[]) {
			expect(source, `the ramp fixture no longer grants ${capability}`).toContain(capability);
		}
		for (const envVar of flag['requiredEnvVars'] as readonly string[]) {
			expect(source, `the ramp fixture no longer names the flag's ${envVar}`).toContain(envVar);
		}
	});
});
