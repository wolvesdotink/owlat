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
 *   probe declared, endpoint doesn't take it   the transport editor draws a
 *                                              "Test connection" button (it
 *                                              derives from `setupProbe`) that
 *                                              answers 400 for every operator
 *                                              who presses it
 *   endpoint takes it, no probe declared       a live check nothing offers, and
 *                                              a validator whose failure modes
 *                                              no surface can report
 *
 * So this asks the SHIPPED endpoint, per catalog kind, and derives both sides
 * from the catalog rather than from a list of kinds kept here. It does not
 * rewrite the endpoint's per-kind switch — that rewrite has no card in this plan
 * and is recorded as such in `scripts/provider-identity-allowlist.txt`. It makes
 * the switch answerable to the declaration.
 */

import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
 * The request body each probe's live check needs, keyed by the VALIDATOR the
 * descriptor names — the same key `useRelayCredentialDraft`'s browser-side
 * builders use, and never the provider kind.
 *
 * A declared probe with no entry here fails the coverage assertion below with a
 * message naming the endpoint, which is the moment an author learns that the
 * switch has to learn the new kind too.
 */
const PROBE_BODIES: Record<string, Record<string, unknown>> = {
	validateResendKey: { apiKey: 're_stub_key' },
	validateSmtpRelay: {
		smtp: {
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			username: 'postmaster@example.com',
			password: 'stub-password',
		},
	},
};

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

	it('knows what each declared probe has to send', () => {
		const uncovered = PROBE_ENTRIES.filter(
			(entry) => PROBE_BODIES[entry.setupProbe!.validator] === undefined
		);
		expect(
			uncovered.map((entry) => `${entry.kind} → ${entry.setupProbe!.validator}`),
			'a kind declaring setupProbe must be one POST /api/delivery/validate-transport ' +
				'accepts — teach that endpoint the kind, then add its request body here'
		).toEqual([]);
	});

	it.each(PROBE_ENTRIES.map((entry) => [entry.kind, entry.setupProbe!.validator]))(
		'%s reaches the validator its descriptor names (%s)',
		async (kind, validator) => {
			body = { provider: kind, ...PROBE_BODIES[validator] };
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
		body = { provider: entry.kind, ...PROBE_BODIES[entry.setupProbe!.validator] };

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
			body = { provider: kind, apiKey: 'irrelevant' };
			await expect(callRoute()).rejects.toMatchObject({
				statusCode: 400,
				message: expect.stringContaining(
					'Only Resend and SMTP relays can be tested before applying'
				),
			});
			expect(probeCalls).toEqual([]);
		}
	);
});
