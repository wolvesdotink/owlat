/**
 * THE PROBE JOIN, PINNED — the seams plan's P1.3, consumer side.
 *
 * `setupProbe` on a catalog entry is a promise made to an operator: this kind's
 * credentials can be CHECKED before they are applied, and here is the validator
 * that checks them. The declaration is in `packages/shared` (whose own suite
 * pins that the named validator resolves to a real export of
 * `setupValidators.ts`); the thing that keeps the promise is
 * `POST /api/delivery/validate-transport`, which still takes one hand-shaped
 * body per probe and is on `lint:providers`' allowlist for exactly that reason.
 *
 * Between the two, nothing asserted that they agreed — and both disagreements
 * are silent:
 *
 *   probe declared, endpoint doesn't take it   every request the editor's "Test
 *                                              connection" button can produce
 *                                              answers 400
 *   endpoint takes it, no probe declared       a live check nothing offers, and
 *                                              a validator whose failure modes
 *                                              no surface can report
 *
 * So this asks the SHIPPED endpoint, per catalog kind, and derives both sides
 * from the catalog rather than from a list of kinds kept here. It does not
 * rewrite the endpoint's per-kind switch — that rewrite has no card in this plan
 * and is recorded as such in `scripts/provider-identity-allowlist.txt`. It makes
 * the switch answerable to the declaration.
 *
 * THE BROWSER'S HALF IS ONE FILE OVER, and it is not the same question. The
 * button is not drawn off `setupProbe` alone: `TransportEditor.vue` reads
 * `canValidateLive`, which asks whether the probe's validator has a request-body
 * builder in `useRelayCredentialDraft.ts` — so a declared probe with no builder
 * there hides the button instead of shipping a broken one. `apps/web/app/
 * composables/__tests__/relayCredentialDraft.test.ts` ("offers a live check for
 * %s only when its entry declares a setup probe") is what pins that table to the
 * catalog in both directions; this file pins the endpoint's switch. Neither can
 * stand for the other: a sixth kind needs an entry in BOTH, and each suite names
 * the one it owns.
 *
 * WHAT THIS FILE DOES NOT HOLD IS A BODY OF ITS OWN. Every request below is
 * built by that same shipped builder (`probeRequestBuilder`, exported for exactly
 * this) over form values seeded from the kind's own descriptors. A fixture table
 * here would have made the suite ask "does the endpoint accept what this test's
 * author wrote", which is answerable by a pair of files that agree with each
 * other and with nothing the operator's browser sends.
 *
 * IT ALSO CARRIES THE ENDPOINT'S ONLY GATE TEST, which is more than the join.
 * `validate-transport.post.ts` had no suite at all before this one, and mocking
 * `requireOrgAdmin` to keep the probes off the network makes DELETING the gate
 * invisible here — on an endpoint that opens a caller-supplied SMTP `host:port`
 * and spends a caller-supplied Resend key. So two assertions below are about
 * authorisation rather than about probes, and they are the only ones anywhere:
 * until the endpoint gets a suite of its own, they do not travel with the join if
 * it ever moves.
 */

import {
	CORE_SEND_PROVIDER_CATALOG_ENTRIES,
	type CoreSendProviderCatalogEntry,
} from '@owlat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	hostPortFieldFor,
	seedCredentialValues,
	type TransportCredentialValues,
} from '~/composables/setupWizardCredentials';
import { probeRequestBuilder } from '~/composables/useRelayCredentialDraft';

/** Which validator the route reached, recorded by the stubs installed below. */
const { probeCalls } = vi.hoisted(() => ({ probeCalls: [] as string[] }));

const { requireOrgAdminMock } = vi.hoisted(() => ({ requireOrgAdminMock: vi.fn() }));

vi.mock('~~/server/utils/requireOrgAdmin', () => ({ requireOrgAdmin: requireOrgAdminMock }));

/**
 * Every validator the CATALOG names, stubbed — never a hand-written pair.
 *
 * The stubs are installed by declared name, so a sixth kind's probe is recorded
 * the day its entry lands rather than silently escaping to the real network call
 * this suite must never make.
 */
vi.mock('@owlat/shared/setupValidators', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	const { CORE_SEND_PROVIDER_CATALOG_ENTRIES: entries } = await import('@owlat/shared');
	const stubbed: Record<string, unknown> = { ...actual };
	for (const entry of entries) {
		const name = entry.setupProbe?.validator;
		if (name === undefined) continue;
		stubbed[name] = async () => {
			probeCalls.push(name);
			return { ok: true, message: `stubbed ${name}` };
		};
	}
	return stubbed;
});

interface ProbeResult {
	ok: boolean;
	message: string;
}

let body: unknown;

async function callRoute(): Promise<ProbeResult> {
	const mod = await import('../validate-transport.post');
	const handler = mod.default as unknown as (event: unknown) => Promise<ProbeResult>;
	return handler({});
}

/**
 * One kind's form as an operator would have left it: the descriptors' declared
 * defaults (`seedCredentialValues` — the very seed the shipped draft starts
 * from), with every text and secret field filled in.
 *
 * Derived per field kind rather than written out, so a sixth provider's form is
 * filled the day its entry lands. Composite and choice fields keep their seeded
 * values, which is what an operator who accepted the defaults would send.
 */
function enteredValues(entry: CoreSendProviderCatalogEntry): TransportCredentialValues {
	const values = seedCredentialValues(entry.kind);
	for (const field of entry.credentialFields) {
		if (field.kind === 'string' || field.kind === 'secret') {
			values[field.envVar] = `stub-${field.key}`;
		}
	}
	return values;
}

/**
 * The body the SHIPPED editor would post for this kind — built by
 * `useRelayCredentialDraft`'s own `probeRequestBuilder`, never by a fixture
 * written here.
 *
 * That is the whole point of the import. A per-validator body table of this
 * suite's own would prove only that the endpoint accepts what its author wrote:
 * rename a key in the browser's builder (`{ key }` for `{ apiKey }`) and both
 * this suite and the composable's would stay green while every "Test connection"
 * click in the shipped editor answered 400. Going through the builder makes that
 * rename fail here, which is the one place it can.
 */
function probeBodyFor(entry: CoreSendProviderCatalogEntry): Record<string, unknown> | undefined {
	const build = probeRequestBuilder(entry.setupProbe?.validator);
	return build?.(enteredValues(entry), hostPortFieldFor(entry.kind));
}

const PROBE_ENTRIES = CORE_SEND_PROVIDER_CATALOG_ENTRIES.filter(
	(entry) => entry.setupProbe !== undefined
);
const UNPROBED_ENTRIES = CORE_SEND_PROVIDER_CATALOG_ENTRIES.filter(
	(entry) => entry.setupProbe === undefined
);

beforeEach(() => {
	probeCalls.length = 0;
	// Reset like the sibling `apply-transport.test.ts` does: a case added later
	// that forgets to set `body` must hit the endpoint's `provider is required.`
	// 400, not inherit the previous test's request and pass for the wrong reason.
	body = undefined;
	requireOrgAdminMock.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal('defineEventHandler', <T>(handler: T) => handler);
	vi.stubGlobal(
		'readBody',
		vi.fn(async () => body)
	);
	vi.stubGlobal('createError', (opts: { statusCode: number; message: string }) =>
		Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
	);
});

describe('the live-check endpoint takes exactly the kinds the catalog says can be checked', () => {
	it('finds kinds on both sides of the question', () => {
		// Neither suite below may run empty: with no probes declared, "every probe
		// reaches its validator" would pass by describing nothing. WHICH kinds
		// declare a probe is a product decision already pinned, per kind and as a
		// literal, by `packages/shared/src/__tests__/sendProviderCatalog.test.ts`
		// ("names a real validator on every setup probe, and only where one
		// exists"); restating the roster here would make a sixth kind's descriptor
		// a multi-file literal edit for a fact this file does not own. So: both
		// sides non-empty, and together they account for every catalog entry.
		expect(PROBE_ENTRIES.length).toBeGreaterThan(0);
		expect(UNPROBED_ENTRIES.length).toBeGreaterThan(0);
		expect([...PROBE_ENTRIES, ...UNPROBED_ENTRIES].map((entry) => entry.kind).sort()).toEqual(
			CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => entry.kind).sort()
		);
	});

	it('has a shipped request body for every declared probe', () => {
		// The precondition of the cases below: with no builder there is no body to
		// post, and each of them would fail on the endpoint's `provider is required.`
		// 400 rather than on the thing it means to ask. WHY a builder must exist is
		// `apps/web/app/composables/__tests__/relayCredentialDraft.test.ts`'s rule —
		// a declared probe with no builder hides the editor's button — so this only
		// says the fixtures below are real, and names the endpoint an author has to
		// teach when they add one.
		const uncovered = PROBE_ENTRIES.filter((entry) => probeBodyFor(entry) === undefined);
		expect(
			uncovered.map((entry) => `${entry.kind} → ${entry.setupProbe!.validator}`),
			'a kind declaring setupProbe must be one POST /api/delivery/validate-transport ' +
				'accepts — teach that endpoint the kind, then give the probe a request-body ' +
				'builder in app/composables/useRelayCredentialDraft.ts'
		).toEqual([]);
	});

	it.each(PROBE_ENTRIES.map((entry) => [entry.kind, entry.setupProbe!.validator] as const))(
		'%s reaches the validator its descriptor names (%s)',
		async (kind, validator) => {
			const entry = CORE_SEND_PROVIDER_CATALOG_ENTRIES.find((row) => row.kind === kind)!;
			body = { provider: kind, ...probeBodyFor(entry) };
			const result = await callRoute();
			// The descriptor's name is not decoration: it is what the transport
			// editor labels the button with and what the browser keys its request
			// body on, so a kind routed to a DIFFERENT validator would report a
			// green handshake for a credential nobody checked.
			expect(probeCalls).toEqual([validator]);
			expect(result.ok).toBe(true);
			// The gate is mocked so this suite makes no network call, which would
			// also make DELETING `await requireOrgAdmin(event)` invisible here — on
			// an endpoint that opens a live SMTP connection to a caller-supplied
			// host:port and spends a caller-supplied Resend key. So assert it ran.
			expect(requireOrgAdminMock).toHaveBeenCalledTimes(1);
		}
	);

	it('runs the admin gate BEFORE any validator, and a refusal reaches no probe', async () => {
		requireOrgAdminMock
			.mockReset()
			.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
		const entry = PROBE_ENTRIES[0]!;
		body = { provider: entry.kind, ...probeBodyFor(entry) };

		await expect(callRoute()).rejects.toMatchObject({ statusCode: 403 });
		// The ordering is the point: a gate that ran AFTER the validator would let
		// an unauthenticated caller reach the outbound connection anyway.
		expect(probeCalls).toEqual([]);
	});

	it.each(UNPROBED_ENTRIES.map((entry) => entry.kind))(
		'%s declares no probe and the endpoint refuses to pretend it has one',
		async (kind) => {
			// The converse. SES, Mandrill and our own MTA have no cheap pre-apply
			// check; their proof is the live send test after applying. An endpoint
			// that quietly accepted them would report a result no validator produced.
			//
			// The MESSAGE, not just the 400: this endpoint answers 400 from four
			// paths (missing `provider`, missing smtp fields, non-numeric port, and
			// the deliberate refusal). Matching only the status would keep this green
			// if a later per-kind branch rejected the same body for its own reasons —
			// i.e. exactly when the endpoint HAD grown a probe the catalog denies.
			//
			// A ROSTER-INDEPENDENT fragment, though. The copy names which kinds CAN
			// be checked, so matching the whole sentence would fail every case here
			// the day a sixth kind gains a probe and the wording is updated — noise
			// on exactly the change this suite exists to guide. This much still
			// cannot be produced by the other three 400s ('provider is required.',
			// 'smtp.host, smtp.username, and smtp.password are required.',
			// 'smtp.port must be a number.').
			body = { provider: kind, apiKey: 'irrelevant' };
			await expect(callRoute()).rejects.toMatchObject({
				statusCode: 400,
				message: expect.stringContaining('can be tested before applying'),
			});
			expect(probeCalls).toEqual([]);
		}
	);
});
