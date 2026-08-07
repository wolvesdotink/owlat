import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared';
import schema from '../../schema';
import { SEND_PROVIDER_KINDS, hasProviderFeedbackFor } from '../../lib/sendProviders/catalog';
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
 * So this file tests the WIRING, in the three directions it can be wrong:
 *
 *  1. COMPLETENESS — a kind the catalog says reports feedback has an adapter,
 *     and a kind with an adapter says so in the catalog. Both are compile errors
 *     in `../adapters/index.ts`; asserted here at runtime too, because the
 *     compile-time half is `Extract`ed over the CORE catalog literal and cannot
 *     see a bundled plugin entry, while `hasProviderFeedbackFor` reads the
 *     COMPOSED catalog that a plugin transport joins.
 *  2. IDENTITY — the key a route dispatches by IS the `source` the pipeline
 *     rate-limits and audits under.
 *  3. DISPATCH — the route registered for a kind reaches THAT kind's adapter,
 *     proven through the real `http.ts` router rather than by reading the file.
 *
 * The dispatch case is the load-bearing one, and it is written so that it cannot
 * pass vacuously: the expectation is computed by asking the registry's own
 * adapter, and a separate case asserts the four adapters answer the probe
 * DIFFERENTLY — so swapping any two registry values fails.
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

/** The catalog's answer, through the accessor the rest of the backend reads. */
const DECLARING_KINDS = SEND_PROVIDER_KINDS.filter((kind) => hasProviderFeedbackFor(kind));

const entries: readonly CoreSendProviderCatalogEntry[] = CORE_SEND_PROVIDER_CATALOG_ENTRIES;

/** The route a kind declares, from the catalog — never derived from the kind. */
function webhookPathFor(kind: ProviderFeedbackKind): string {
	const path = entries.find((entry) => entry.kind === kind)?.providerFeedback?.webhookPath;
	expect(path, `${kind} declares no providerFeedback.webhookPath`).toBeDefined();
	return path!;
}

/**
 * Every deployment variable the feedback kinds declare, set to a dummy value.
 *
 * Derived from the catalog rather than listed per kind so a sixth provider needs
 * no edit here. The point is to get each adapter PAST its fail-closed
 * "not configured" gate (503, and identical across kinds) and into the
 * per-provider rejection that identifies it.
 */
function feedbackEnvVars(): string[] {
	const names = new Set<string>();
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

describe('the registry covers exactly the kinds that declare feedback', () => {
	it('has subjects at all', () => {
		// A guard on the guards below: an empty registry or an empty catalog read
		// would satisfy every set comparison in this file vacuously.
		expect(REGISTERED_KINDS.length).toBeGreaterThan(1);
		expect(DECLARING_KINDS.length).toBeGreaterThan(1);
	});

	it('registers an adapter for every kind whose catalog entry declares feedback', () => {
		// `hasProviderFeedback: true` promises an operator that pasting our
		// endpoint into a provider console makes bounces and complaints arrive.
		// A declaration with no adapter is a route that does not exist — and the
		// measurement plane still grades that arm as one whose bad news arrives
		// out of band, so silence reads as a clean arm.
		expect([...DECLARING_KINDS].sort()).toEqual([...REGISTERED_KINDS].sort());
	});

	it('registers no adapter for a kind that declares no feedback', () => {
		// The converse, stated separately so a failure says which direction broke.
		const undeclared = REGISTERED_KINDS.filter((kind) => !hasProviderFeedbackFor(kind));
		expect(undeclared).toEqual([]);
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

	it('the probe tells the adapters apart', () => {
		// Without this, the per-kind cases below would still pass with every route
		// wired to one adapter. It is the assertion that makes them differential —
		// and if a future adapter's wording collides with another's, this fails
		// first and says so, instead of the suite quietly going blind.
		return Promise.all(REGISTERED_KINDS.map(adapterVerdict)).then((verdicts) => {
			const distinct = new Set(verdicts.map((v) => `${v.status} ${v.reason}`));
			expect(distinct.size).toBe(REGISTERED_KINDS.length);
		});
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
