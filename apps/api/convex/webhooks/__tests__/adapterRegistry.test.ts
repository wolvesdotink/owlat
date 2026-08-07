import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared';
import schema from '../../schema';
import {
	SEND_PROVIDER_CATALOG,
	SEND_PROVIDER_KINDS,
	hasProviderFeedbackFor,
	isCoreSendProviderKind,
} from '../../lib/sendProviders/catalog';
import {
	PROVIDER_FEEDBACK_ADAPTERS,
	feedbackAdapterFor,
	type ProviderFeedbackKind,
} from '../adapters';

/**
 * THE FEEDBACK-PLANE REGISTRY (the seams plan's D6 / P2.1).
 *
 * Four thin `httpAction` files — one per provider, each naming an adapter and
 * doing nothing else — became one registry plus one parameterized dispatcher.
 * That trade removes four files nobody could forget to write only by adding one
 * thing that can go wrong instead: the KEY. A registry entry filed under the
 * wrong kind is a webhook that verifies with another provider's secret, spends
 * another provider's rate-limit bucket and files its raw payloads under another
 * provider's `source` — and every per-adapter suite stays green, because they
 * test adapters, not wiring.
 *
 * So this file tests the WIRING, in the four directions it can be wrong:
 *
 *  1. COMPLETENESS — a CORE kind the catalog says reports feedback has an
 *     adapter, and a registered kind says so in the catalog. Both are compile
 *     errors in `../adapters/index.ts`; asserted here at runtime too, because
 *     the compile-time half is `Extract`ed over the core catalog LITERAL and a
 *     runtime assertion is what survives a refactor of that type.
 *  2. COVERAGE — every kind of the COMPOSED catalog that declares feedback is
 *     served by SOME feedback surface. Deliberately weaker than (1) and stated
 *     separately, because a bundled plugin transport's feedback does not belong
 *     in this registry at all (D6: `/webhooks/plugin/<pluginId>`, the seams
 *     plan's P2.2). Set-equality against the composed catalog would say the
 *     opposite, and would say it as an instruction.
 *  3. IDENTITY — the key a route dispatches by IS the `source` the pipeline
 *     rate-limits and audits under, and the value behind it is a real adapter.
 *  4. DISPATCH — the route registered for a kind reaches THAT kind's adapter,
 *     proven through the real `http.ts` router rather than by reading the file.
 *
 * The dispatch case is the load-bearing one, and it is written so that it cannot
 * pass vacuously: the expectation is computed by asking the registry's own
 * adapter, and a separate case asserts the four adapters answer the probe
 * DIFFERENTLY — so swapping any two registry values fails.
 *
 * The adapter SHAPE assertions in (3) moved here from
 * `lib/sendProviders/__tests__/catalogConsistency.test.ts`, whose section 3 was
 * an explicit placeholder for this registry ("Wave 2's P2.1 turns this into a
 * mapped-type registry guard; until then it is this"). It located adapters by
 * globbing `webhooks/adapters/<kind>.ts`, which pinned a FILE LAYOUT the
 * registry does not care about; the registry itself is the authority now.
 */

// Vite's `import.meta.glob` excludes the directory chain it climbed to reach the
// glob base, so `'../../**'` from this `webhooks/__tests__` file omits the
// sibling `webhooks/*` modules. Merge a second glob rooted at `webhooks/` and
// re-prefix its keys to the same `../../`-relative form (the idiom
// `analytics/__tests__/reputationSnapshots.test.ts` documents).
const rootGlob = import.meta.glob('../../**/*.*s');
const webhooksGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../webhooks/'),
		mod,
	])
);
const modules = { ...rootGlob, ...webhooksGlob };

function setupTest() {
	const t = convexTest(schema, modules);
	// The inbound pipeline rate-limits before signature verification, so every
	// request here hits the rate-limiter component.
	rateLimiterTest.register(t);
	return t;
}

const REGISTERED_KINDS = Object.keys(PROVIDER_FEEDBACK_ADAPTERS) as ProviderFeedbackKind[];

/**
 * The catalog's answer, through the accessor the rest of the backend reads — over
 * the COMPOSED catalog, so a bundled plugin transport is in scope.
 */
const DECLARING_KINDS = SEND_PROVIDER_KINDS.filter((kind) => hasProviderFeedbackFor(kind));

/** The same question restricted to the tier this registry serves. */
const DECLARING_CORE_KINDS = DECLARING_KINDS.filter((kind) => isCoreSendProviderKind(kind));

const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;

/** The route a kind declares, from the catalog — never derived from the kind. */
function webhookPathFor(kind: ProviderFeedbackKind): string {
	const path = entries.find((entry) => entry.kind === kind)?.providerFeedback?.webhookPath;
	expect(path, `${kind} declares no providerFeedback.webhookPath`).toBeDefined();
	return path!;
}

/**
 * Feedback prerequisites the CATALOG does not carry, because they are not send
 * credentials and not signing keys.
 *
 * `SES_SNS_TOPIC_ARN` is the only one today. SES's `verifySignature` gates on it
 * SECOND, after `AWS_SES_REGION` — a valid SNS signature proves only that AWS
 * sent the envelope, not that OUR topic did, so the adapter refuses to verify at
 * all until the operator has named their topic. It is therefore neither a
 * `requiredEnvVar` (the send path never reads it) nor a
 * `providerFeedback.signingKeyEnvVar` (SNS signs with a certificate, not a
 * shared key), and nothing derived from the entry can find it. Without it set,
 * `/webhooks/ses` never reaches the SNS envelope check and the dispatch case
 * below would compare two copies of a configuration 503 instead of proving the
 * route reached SES's verifier.
 */
const UNDECLARED_FEEDBACK_PREREQUISITES = ['SES_SNS_TOPIC_ARN'] as const;

/**
 * Every deployment variable the feedback kinds declare, set to a dummy value.
 *
 * Derived from the catalog rather than listed per kind so a sixth provider needs
 * no edit here. The point is to get each adapter PAST its fail-closed
 * "not configured" gate and into the per-provider rejection that identifies it.
 *
 * (Those 503s are already distinguishable — `missingSecretResult` interpolates
 * the variable name, and SES writes its own two — so the differential case would
 * still pass with nothing configured. It would pass for the wrong reason: four
 * adapters agreeing they are unconfigured, rather than four verifiers rejecting
 * a forged envelope in four different ceremonies. Configuring them is what makes
 * the discriminator the SIGNATURE PATH.)
 */
function feedbackEnvVars(): string[] {
	const names = new Set<string>(UNDECLARED_FEEDBACK_PREREQUISITES);
	for (const kind of REGISTERED_KINDS) {
		const entry = entries.find((candidate) => candidate.kind === kind);
		for (const name of entry?.requiredEnvVars ?? []) names.add(name);
		for (const name of entry?.optionalEnvVars ?? []) names.add(name);
		const signingKey = entry?.providerFeedback?.signingKeyEnvVar;
		if (signingKey) names.add(signingKey);
	}
	return [...names];
}

/**
 * The probe: a POST with a well-formed but unsigned body and no signature
 * headers. Every adapter rejects it, and each rejects it in its OWN words —
 * which is exactly the observable that tells one adapter from another without
 * reproducing four signing ceremonies (those are the per-adapter suites' job,
 * including the SES SNS subscription-confirmation one, and they are untouched).
 */
const PROBE_BODY = '{}';

function probeRequest(path: string): Request {
	return new Request(`https://example.convex.site${path}`, {
		method: 'POST',
		body: PROBE_BODY,
		headers: { 'Content-Type': 'application/json' },
	});
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	for (const name of feedbackEnvVars()) process.env[name] = `test-${name.toLowerCase()}`;
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

describe('the registry covers exactly the CORE kinds that declare feedback', () => {
	it('has subjects at all', () => {
		// A guard on the guards below: an empty registry or an empty catalog read
		// would satisfy every set comparison in this file vacuously.
		expect(REGISTERED_KINDS.length).toBeGreaterThan(1);
		expect(DECLARING_CORE_KINDS.length).toBeGreaterThan(1);
	});

	it('registers an adapter for every CORE kind whose catalog entry declares feedback', () => {
		// `hasProviderFeedback: true` promises an operator that pasting our
		// endpoint into a provider console makes bounces and complaints arrive.
		// A declaration with no adapter is a route that does not exist — and the
		// measurement plane still grades that arm as one whose bad news arrives
		// out of band, so silence reads as a clean arm.
		//
		// EQUALITY, but only over the CORE tier. Against the COMPOSED catalog this
		// would be a wrong statement waiting for its first counterexample: the day a
		// bundled plugin transport declares feedback its events correctly arrive on
		// `/webhooks/plugin/<pluginId>` and NOT here (D6), and a set-equality
		// failure would read as an instruction to register a plugin kind in the core
		// registry — precisely the conflation D6 forbids. The composed tier gets its
		// own, weaker statement below.
		expect([...DECLARING_CORE_KINDS].sort()).toEqual([...REGISTERED_KINDS].sort());
	});

	it('registers no adapter for a kind that declares no feedback', () => {
		// The converse, stated separately so a failure says which direction broke.
		const undeclared = REGISTERED_KINDS.filter((kind) => !hasProviderFeedbackFor(kind));
		expect(undeclared).toEqual([]);
	});
});

describe('every declared feedback channel is served by some surface', () => {
	// The composed-catalog direction: weaker than the equality above by design,
	// because "served" has two correct answers depending on the tier.
	it.each([...DECLARING_KINDS])('%s has a feedback surface', (kind) => {
		if (isCoreSendProviderKind(kind)) {
			expect(
				REGISTERED_KINDS as readonly string[],
				`${kind} declares hasProviderFeedback and is a CORE kind, so its events arrive ` +
					'on a static /webhooks/<kind> route dispatched through PROVIDER_FEEDBACK_ADAPTERS ' +
					'— register it in webhooks/adapters/index.ts'
			).toContain(kind);
			return;
		}

		// A bundled plugin transport. Its feedback surface is keyed by PLUGIN ID,
		// not by kind — one route `/webhooks/plugin/<pluginId>` behind the hosted
		// contribution authorization (D6, the seams plan's P2.2). Registering it
		// here instead would give it a core route with no grant check, which is the
		// conflation D6 exists to prevent. So what this asserts of a plugin kind is
		// the prerequisite that surface needs: an id to be keyed by.
		const entry = SEND_PROVIDER_CATALOG.find((candidate) => candidate.kind === kind);
		expect(
			entry?.pluginId,
			`${kind} declares hasProviderFeedback and is a PLUGIN kind, so its events belong ` +
				'on /webhooks/plugin/<pluginId>, NOT in PROVIDER_FEEDBACK_ADAPTERS — but the ' +
				'entry carries no pluginId to route by'
		).toBeTruthy();
	});
});

describe('a registry key is the adapter that answers to it', () => {
	it.each(REGISTERED_KINDS)('%s is keyed by its own source', (kind) => {
		// `source` is the rate-limit bucket (`<source>:<ip>`) and the `source` every
		// stored raw payload is filed under. Keyed and sourced disagreeing means one
		// provider's flood can 429 another's bounce feed, and the audit trail names
		// the wrong vendor.
		expect(PROVIDER_FEEDBACK_ADAPTERS[kind].source).toBe(kind);
	});

	it.each(REGISTERED_KINDS)('%s resolves through feedbackAdapterFor', (kind) => {
		expect(feedbackAdapterFor(kind)).toBe(PROVIDER_FEEDBACK_ADAPTERS[kind]);
	});

	it.each(REGISTERED_KINDS)('%s satisfies the InboundAdapter contract at runtime', (kind) => {
		// The `InboundAdapter` / `InboundBatchAdapter` shape, asserted at RUNTIME
		// rather than left to the mapped type — the values reach this registry
		// through four module imports, and a value the type describes but the
		// module does not produce (a mis-shaped generated adapter, a barrel that
		// re-exported the wrong symbol) is a `verifySignature is not a function`
		// inside a live webhook, one frame after the route resolved.
		//
		// Moved here from catalogConsistency.test.ts section 3, which asserted the
		// same shape on whatever `webhooks/adapters/<kind>.ts` exported. This asks
		// the registry instead, so the assertion follows the adapter if the file
		// layout ever changes.
		const adapter = PROVIDER_FEEDBACK_ADAPTERS[kind] as unknown as Record<string, unknown>;
		expect(typeof adapter['verifySignature']).toBe('function');
		const single = typeof adapter['parseEvent'] === 'function';
		const batch = typeof adapter['parseEvents'] === 'function';
		expect(single !== batch, 'exactly one of parseEvent / parseEvents').toBe(true);
	});

	it('refuses an inherited property rather than handing it back as an adapter', () => {
		// Registration is `hasOwnProperty`: `constructor` and `__proto__` resolve on
		// any object literal, and a truthiness lookup would hand one of them back to
		// be called as an adapter one frame later, inside a webhook.
		for (const notAKind of ['constructor', '__proto__', 'toString', 'postmark']) {
			expect(() => feedbackAdapterFor(notAKind as ProviderFeedbackKind)).toThrow(
				/Unknown provider feedback adapter/
			);
		}
	});
});

describe('each static route dispatches through its own registered adapter', () => {
	/** What the registry's adapter for `kind` says about the probe, asked directly. */
	async function adapterVerdict(
		kind: ProviderFeedbackKind
	): Promise<{ status: number; reason: string }> {
		const verdict = await PROVIDER_FEEDBACK_ADAPTERS[kind].verifySignature(
			probeRequest(webhookPathFor(kind)),
			PROBE_BODY
		);
		expect(verdict.ok, `${kind} accepted an unsigned probe`).toBe(false);
		if (verdict.ok) throw new Error('unreachable');
		return { status: verdict.status, reason: verdict.reason };
	}

	it('the probe reaches every adapter’s verifier, and tells them apart', async () => {
		// Without this, the per-kind cases below would still pass with every route
		// wired to one adapter. It is the assertion that makes them differential —
		// and if a future adapter's wording collides with another's, this fails
		// first and says so, instead of the suite quietly going blind.
		const verdicts = await Promise.all(REGISTERED_KINDS.map(adapterVerdict));

		// FIRST that each verdict came from the SIGNATURE path, not from the
		// fail-closed configuration gate in front of it. Those 503s are already
		// distinguishable from one another (`missingSecretResult` interpolates the
		// variable name), so the distinctness check below passes just as happily on
		// four adapters that all said "not configured" — a discriminator that holds
		// for a reason the test never intended and that a later pass at uniform
		// error copy would silently remove. `beforeEach` sets every declared
		// variable plus `UNDECLARED_FEEDBACK_PREREQUISITES`; if a new adapter gates
		// on something neither covers, this is what says so.
		for (const [index, verdict] of verdicts.entries()) {
			expect(
				verdict.status,
				`${REGISTERED_KINDS[index]} answered the probe from its CONFIGURATION gate ` +
					`(${verdict.reason}) — the env this suite installs does not satisfy it, so the ` +
					'dispatch cases below never reach its signature verification'
			).not.toBe(503);
		}

		const distinct = new Set(verdicts.map((v) => `${v.status} ${v.reason}`));
		expect(distinct.size).toBe(REGISTERED_KINDS.length);
	});

	it.each(REGISTERED_KINDS)(
		'%s: the route the catalog declares answers in that kind‘s own words',
		async (kind) => {
			const path = webhookPathFor(kind);
			const expected = await adapterVerdict(kind);

			const t = setupTest();
			const response = await t.fetch(path, {
				method: 'POST',
				body: PROBE_BODY,
				headers: { 'Content-Type': 'application/json' },
			});

			// The pipeline renders a failed verification as
			// `jsonResponse(status, { error: reason })`, so this compares the ROUTE's
			// answer to the REGISTRY's — no literal reproduced here that a copy of the
			// implementation could satisfy.
			expect(response.status).toBe(expected.status);
			expect(await response.json()).toEqual({ error: expected.reason });
		}
	);

	it('answers the unsigned URL-validation probe on the GET route', async () => {
		// Some provider consoles will not save a webhook URL until an unsigned
		// HEAD/GET is acknowledged; Convex resolves HEAD to the GET handler. It is
		// deliberately outside the POST-only pipeline, which would reject it.
		const t = setupTest();
		const response = await t.fetch('/webhooks/mandrill', { method: 'GET' });
		expect(response.status).toBe(200);
	});
});
