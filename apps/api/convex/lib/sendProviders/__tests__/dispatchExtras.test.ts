/**
 * PER-SEND EXTRAS BELONG TO THE PROVIDER MODULE (plan P0.1).
 *
 * `delivery/governedDispatch.ts` used to build every kind's extras itself, in a
 * `providerKind === 'mta' ? … : 'resend' ? … : 'smtp' ? … : {}` chain — so a new
 * provider kind could not have a single per-send knob without editing the
 * governed send path. The chain now lives in the adapters, reached through
 * `buildDispatchExtrasFor`.
 *
 * That move is worth nothing if it changed what goes on the wire, so this suite
 * is a DIFFERENTIAL one: `legacyExtras` below is the pre-refactor ternary,
 * transcribed verbatim, and every case asserts the module output equals it —
 * key set included, because an extra `undefined`-valued key is invisible to
 * `toEqual` and visible to `JSON.stringify`, which is what actually reaches the
 * MTA.
 *
 * The second half of P0.1 finished the same job for the four behaviours that
 * were still spelled `providerKind === 'mta'` — identity binding, message-id
 * substitution, acceptance, and the reconciliation of an ambiguous acceptance.
 * They are now declared on the catalog entry (`acceptanceSemantics`,
 * `messageIdSource`); `describe('declared dispatch semantics')` below PINS those
 * declarations against the real, unmocked catalog, and the proof that the
 * governed boundary obeys the declaration rather than the kind name lives beside
 * the function it tests, in
 * `delivery/__tests__/governedDispatch.test.ts` → `describe('reads the declared
 * dispatch semantics, not the kind')`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDispatchExtrasFor, providerFor } from '../index';
import {
	acceptanceSemanticsFor,
	messageIdSourceFor,
	preassignsProviderMessageId,
	SEND_PROVIDER_CATALOG,
	SEND_PROVIDER_KINDS,
} from '../catalog';
import type {
	DispatchExtrasInput,
	MandrillExtras,
	MtaIpPool,
	SendProviderKind,
	SmtpExtras,
} from '../types';

const ENVELOPE_INPUT = {
	kind: 'campaign',
	emailSendId: 'send-row-1',
	organizationId: 'org-1',
} as const;

/** The three fields the re-entry callback digest is computed over. */
const REENTRY_RETRY_STATE = {
	attempt: 2,
	startedAt: 1_770_000_000_000,
	idempotencyKey: 'send_send-row-1',
};

/** A governed campaign send on the owned MTA with everything resolved. */
function facts(overrides: Partial<DispatchExtrasInput> = {}): DispatchExtrasInput {
	return {
		idempotencyKey: 'send_send-row-1',
		workAttemptId: 'work-attempt-1',
		organizationId: 'org-1',
		messageType: 'campaign',
		deliveryDomain: 'production',
		routingReentryToken: 'reentry-token',
		routingReentry: { envelopeInput: ENVELOPE_INPUT, retryState: REENTRY_RETRY_STATE },
		routingLease: 'lease-1',
		ipPool: 'campaign',
		warmupOverflowEnabled: false,
		engagementScore: 87,
		relayReturnPathHost: 'bounces.example.com',
		...overrides,
	};
}

/**
 * The pre-refactor `delivery/governedDispatch.ts` ternary, transcribed. Kept
 * spelled out (rather than described in prose) so "behaviour is identical" is a
 * claim the suite can execute instead of one a reviewer has to take on trust.
 */
function legacyExtras(providerKind: SendProviderKind, input: DispatchExtrasInput): unknown {
	const route =
		input.ipPool === undefined && input.warmupOverflowEnabled === undefined
			? null
			: { ipPool: input.ipPool, warmupOverflowEnabled: input.warmupOverflowEnabled };
	const engagementScore = input.engagementScore;
	return providerKind === 'mta'
		? {
				messageId: input.idempotencyKey,
				workAttemptId: input.workAttemptId,
				routingReentryToken: input.routingReentryToken,
				routingReentry: {
					envelopeInput: input.routingReentry.envelopeInput,
					retryState: input.routingReentry.retryState,
				},
				organizationId: input.organizationId,
				messageType: input.messageType,
				deliveryDomain: input.deliveryDomain,
				routingLease: input.routingLease,
				allowWarmupOverflow: Boolean(
					input.messageType === 'campaign' && route?.warmupOverflowEnabled
				),
				...(route?.ipPool ? { ipPool: route.ipPool as MtaIpPool } : {}),
				...(engagementScore !== undefined ? { engagementScore } : {}),
			}
		: providerKind === 'resend'
			? { idempotencyKey: input.idempotencyKey }
			: providerKind === 'smtp'
				? input.relayReturnPathHost === undefined
					? ({} satisfies SmtpExtras)
					: ({ returnPathHost: input.relayReturnPathHost } satisfies SmtpExtras)
				: {};
}

/** Key sets, `undefined` values included — `toEqual` alone would miss those. */
function keysOf(value: unknown): string[] {
	return Object.keys(value as Record<string, unknown>).sort();
}

function expectMatchesLegacy(kind: SendProviderKind, input: DispatchExtrasInput): unknown {
	const built = buildDispatchExtrasFor(kind, input);
	const legacy = legacyExtras(kind, input);
	expect(built).toEqual(legacy);
	expect(keysOf(built)).toEqual(keysOf(legacy));
	return built;
}

/**
 * The kinds that EXISTED before the seam moved, and therefore have a legacy
 * ternary branch to be differentiated against. `mandrill` (plan P1.2) never had
 * one: it was born after the seam closed, so replaying it here would only prove
 * it differs from a `{}` that was never its behaviour. Its extras are specified
 * outright in `describe('mandrill extras')` below instead.
 */
const LEGACY_KINDS = ['mta', 'ses', 'resend', 'smtp'] as const;

const CORE_KINDS = [...LEGACY_KINDS, 'mandrill'] as const;

/**
 * Representative routing situations, each one a shape the routing pass really
 * produces. Every kind is replayed against all of them.
 */
const SITUATIONS: ReadonlyArray<{ name: string; input: DispatchExtrasInput }> = [
	{ name: 'governed campaign, everything resolved', input: facts() },
	{
		name: 'transactional send (no warm-up overflow is ever granted)',
		input: facts({ messageType: 'transactional', warmupOverflowEnabled: true }),
	},
	{
		name: 'campaign the route permits over the warm-up cap',
		input: facts({ warmupOverflowEnabled: true }),
	},
	{
		name: 'unconfigured route — no pool, no lease, no authorised return path',
		input: facts({
			ipPool: undefined,
			warmupOverflowEnabled: undefined,
			routingLease: undefined,
			relayReturnPathHost: undefined,
		}),
	},
	{ name: 'unscored recipient', input: facts({ engagementScore: undefined }) },
	{
		name: 'coldest scored recipient (0 is a band, not an absence)',
		input: facts({ engagementScore: 0 }),
	},
	{ name: 'member-test provenance', input: facts({ deliveryDomain: 'member_test' }) },
	{
		name: 'reconciliation attempt on a relay-shaped route',
		input: facts({ ipPool: 'transactional' }),
	},
];

describe('buildDispatchExtras — differential against the pre-refactor ternary', () => {
	for (const kind of LEGACY_KINDS) {
		for (const situation of SITUATIONS) {
			it(`${kind}: ${situation.name}`, () => {
				expectMatchesLegacy(kind, situation.input);
			});
		}
	}
});

describe('mta extras', () => {
	it('carries the full governance packet', () => {
		expect(buildDispatchExtrasFor('mta', facts())).toEqual({
			messageId: 'send_send-row-1',
			workAttemptId: 'work-attempt-1',
			routingReentryToken: 'reentry-token',
			routingReentry: { envelopeInput: ENVELOPE_INPUT, retryState: REENTRY_RETRY_STATE },
			organizationId: 'org-1',
			messageType: 'campaign',
			deliveryDomain: 'production',
			routingLease: 'lease-1',
			allowWarmupOverflow: false,
			ipPool: 'campaign',
			engagementScore: 87,
		});
	});

	it('forwards the re-entry material unchanged — the callback digest covers it', () => {
		const input = facts();
		const extras = buildDispatchExtrasFor('mta', input) as {
			routingReentry: DispatchExtrasInput['routingReentry'];
		};
		expect(extras.routingReentry).toEqual(input.routingReentry);
		expect(Object.keys(extras.routingReentry.retryState).sort()).toEqual([
			'attempt',
			'idempotencyKey',
			'startedAt',
		]);
	});

	it('OMITS an unscored recipient rather than sending 0 (the coldest band)', () => {
		const unscored = buildDispatchExtrasFor('mta', facts({ engagementScore: undefined }));
		expect(keysOf(unscored)).not.toContain('engagementScore');
		expect(keysOf(buildDispatchExtrasFor('mta', facts({ engagementScore: 0 })))).toContain(
			'engagementScore'
		);
	});

	it('omits an empty pool name instead of sending one', () => {
		expect(keysOf(buildDispatchExtrasFor('mta', facts({ ipPool: undefined })))).not.toContain(
			'ipPool'
		);
		expect(keysOf(buildDispatchExtrasFor('mta', facts({ ipPool: '' })))).not.toContain('ipPool');
	});

	it.each([
		{ messageType: 'campaign', warmupOverflowEnabled: true, expected: true },
		{ messageType: 'campaign', warmupOverflowEnabled: false, expected: false },
		{ messageType: 'campaign', warmupOverflowEnabled: undefined, expected: false },
		// A warming schedule paces campaigns; transactional mail never spends its
		// overflow, whatever the route permits.
		{ messageType: 'transactional', warmupOverflowEnabled: true, expected: false },
		{ messageType: 'automation', warmupOverflowEnabled: true, expected: false },
	] as const)(
		'grants warm-up overflow to $messageType with route permission $warmupOverflowEnabled → $expected',
		({ messageType, warmupOverflowEnabled, expected }) => {
			const extras = buildDispatchExtrasFor(
				'mta',
				facts({ messageType, warmupOverflowEnabled })
			) as { allowWarmupOverflow: boolean };
			expect(extras.allowWarmupOverflow).toBe(expected);
		}
	);
});

describe('resend extras', () => {
	it('is the stable idempotency key and nothing else', () => {
		expect(buildDispatchExtrasFor('resend', facts())).toEqual({
			idempotencyKey: 'send_send-row-1',
		});
	});

	it('ignores every routing fact — Resend has no route-shaped knobs', () => {
		expect(buildDispatchExtrasFor('resend', facts({ ipPool: 'transactional' }))).toEqual(
			buildDispatchExtrasFor('resend', facts({ ipPool: undefined }))
		);
	});
});

describe('smtp extras', () => {
	it('stamps the authorised return-path host (plan G-08)', () => {
		expect(buildDispatchExtrasFor('smtp', facts())).toEqual({
			returnPathHost: 'bounces.example.com',
		});
	});

	it('fails closed to the composer envelope sender when no host was authorised', () => {
		const extras = buildDispatchExtrasFor('smtp', facts({ relayReturnPathHost: undefined }));
		expect(extras).toEqual({});
		// Absent, not present-and-undefined: the adapter reads `?.returnPathHost`
		// and an explicit key would still be no host, but the two differ on the
		// wire the moment anything serializes this.
		expect(keysOf(extras)).toEqual([]);
	});
});

describe('mandrill extras', () => {
	it('carries the route pool and the PROVEN return-path domain, nothing else', () => {
		expect(buildDispatchExtrasFor('mandrill', facts())).toEqual({
			ipPool: 'campaign',
			returnPathDomain: 'bounces.example.com',
		} satisfies MandrillExtras);
	});

	it('passes an arbitrary pool name through — Mandrill pools are account-defined', () => {
		// Unlike `MtaExtras.ipPool` there is no canonical name list: whatever the
		// account created is a valid pool, so the seam must not filter it.
		expect(buildDispatchExtrasFor('mandrill', facts({ ipPool: 'Warmup Pool 2' }))).toMatchObject({
			ipPool: 'Warmup Pool 2',
		});
	});

	it('omits an absent or empty pool rather than sending one', () => {
		expect(keysOf(buildDispatchExtrasFor('mandrill', facts({ ipPool: undefined })))).not.toContain(
			'ipPool'
		);
		expect(keysOf(buildDispatchExtrasFor('mandrill', facts({ ipPool: '' })))).not.toContain(
			'ipPool'
		);
	});

	it('omits the return-path domain until the probe proves the transport honours one (D5)', () => {
		// The catalog declares `supportsCustomReturnPath: 'probe'`, so an unproven
		// transport must NOT be handed a `return_path_domain`: Mandrill would
		// silently ignore or reject a domain that is not SPF'd to it, and the cell
		// would be graded on bounce data that never came back to us.
		const unproven = buildDispatchExtrasFor(
			'mandrill',
			facts({ relayReturnPathHost: undefined, ipPool: undefined })
		);
		expect(unproven).toEqual({});
		expect(keysOf(unproven)).toEqual([]);
	});

	it('never carries the subaccount — extras are routing facts, not deployment config', () => {
		// MANDRILL_SUBACCOUNT is read INSIDE `sendEmail`; `buildDispatchExtras` is
		// env-free by contract, and a subaccount arriving through this seam would be
		// the first crack in that rule.
		for (const situation of SITUATIONS) {
			expect(keysOf(buildDispatchExtrasFor('mandrill', situation.input))).not.toContain(
				'subaccount'
			);
		}
	});
});

describe('ses extras', () => {
	it('takes no per-send extras — MAIL FROM and dedup are both decided elsewhere', () => {
		expect(buildDispatchExtrasFor('ses', facts())).toEqual({});
		expect(keysOf(buildDispatchExtrasFor('ses', facts()))).toEqual([]);
	});
});

describe('the module contract', () => {
	it('every core kind answers the builder through its own module', () => {
		for (const kind of CORE_KINDS) {
			const module = providerFor(kind);
			expect(typeof module.buildDispatchExtras).toBe('function');
			expect(module.buildDispatchExtras?.(facts())).toEqual(buildDispatchExtrasFor(kind, facts()));
		}
	});

	it('is pure — same facts in, equal extras out, and no shared object to mutate', () => {
		for (const kind of CORE_KINDS) {
			const input = Object.freeze(facts());
			const first = buildDispatchExtrasFor(kind, input) as Record<string, unknown>;
			const second = buildDispatchExtrasFor(kind, input) as Record<string, unknown>;
			expect(first).toEqual(second);
			expect(first).not.toBe(second);
			first['injected'] = true;
			expect(keysOf(buildDispatchExtrasFor(kind, input))).not.toContain('injected');
		}
	});

	it('a kind with no builder takes the empty extras the governed path always sent', () => {
		// Hosted (plugin) transports parse their own extras from a data-only value
		// the host hands them; they take nothing from this boundary. There is no
		// bundled one in this build, so assert the rule the registry enforces.
		const hostedKinds = SEND_PROVIDER_CATALOG.filter((entry) => entry.pluginId !== undefined);
		for (const entry of hostedKinds) {
			expect(buildDispatchExtrasFor(entry.kind, facts())).toEqual({});
		}
		expect(buildDispatchExtrasFor('plugin.absent.transport' as SendProviderKind, facts())).toEqual(
			{}
		);
	});
});

/**
 * WHAT EACH SHIPPED KIND DECLARES — read from the REAL catalog. Nothing in this
 * file mocks `../catalog`, deliberately: a steerable accessor here could report
 * whatever a test had last set and these pins would then pass for any catalog
 * content. The suite that does need to steer the declarations
 * (`delivery/__tests__/governedDispatch.test.ts`) keeps its mock to itself.
 */
describe('declared dispatch semantics', () => {
	/**
	 * Each core kind must ANSWER both questions — `CoreSendProviderCatalogEntry`
	 * makes them required, so this pins the answers rather than their presence.
	 */
	it.each([
		{ kind: 'mta', acceptance: 'accepted', messageId: 'idempotency-key' },
		{ kind: 'ses', acceptance: 'unknown-on-timeout', messageId: 'provider' },
		{ kind: 'resend', acceptance: 'unknown-on-timeout', messageId: 'provider' },
		// A relay hands back no id of its own: the adapter reports the RFC 5322
		// `Message-ID` the composer minted (`smtp/index.ts` → `composed.messageId`).
		{ kind: 'smtp', acceptance: 'unknown-on-timeout', messageId: 'composed' },
		{ kind: 'mandrill', acceptance: 'unknown-on-timeout', messageId: 'provider' },
	] as const)('$kind declares $acceptance / $messageId', ({ kind, acceptance, messageId }) => {
		expect(acceptanceSemanticsFor(kind)).toBe(acceptance);
		expect(messageIdSourceFor(kind)).toBe(messageId);
	});

	it('takes custody for exactly the transports that mint no id of their own', () => {
		// The coupling is not decorative: the ambiguous-acceptance arm resolves by
		// REPLAYING the attempt, which is only safe because the replay carries the
		// same idempotency key. A kind that claimed custody without owning its
		// message id would double-deliver on every lost response (D4).
		for (const kind of SEND_PROVIDER_KINDS) {
			if (acceptanceSemanticsFor(kind) !== 'accepted') continue;
			expect(messageIdSourceFor(kind)).toBe('idempotency-key');
			expect(preassignsProviderMessageId(kind)).toBe(true);
		}
	});

	it('fails closed for an entry that declares neither', () => {
		// Bundled plugin entries are generated from manifests, which carry no
		// semantics surface yet (parity is plan P3.1). An absent declaration must
		// read as "no custody, no id of ours" — never the reverse.
		for (const entry of SEND_PROVIDER_CATALOG) {
			if (entry.acceptanceSemantics === undefined) {
				expect(acceptanceSemanticsFor(entry.kind)).toBe('unknown-on-timeout');
			}
			if (entry.messageIdSource === undefined) {
				expect(messageIdSourceFor(entry.kind)).toBe('provider');
				expect(preassignsProviderMessageId(entry.kind)).toBe(false);
			}
		}
	});
});

describe('the seam stays closed', () => {
	it('governed dispatch compares no provider kind to a literal (D2)', () => {
		// The point of P0.1, both halves: extras belong to the module and the
		// acceptance/identity semantics belong to the catalog, so the governed send
		// path must not know that ANY particular kind exists — `'mta'` included,
		// which is what the second half of the piece removed.
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '../../../delivery/governedDispatch.ts'),
			'utf8'
		);
		for (const kind of SEND_PROVIDER_KINDS) {
			expect(source).not.toContain(`'${kind}'`);
		}
	});
});
