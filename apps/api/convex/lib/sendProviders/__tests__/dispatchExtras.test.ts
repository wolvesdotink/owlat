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
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDispatchExtrasFor, providerFor } from '../index';
import { SEND_PROVIDER_CATALOG } from '../catalog';
import type { DispatchExtrasInput, MtaIpPool, SendProviderKind, SmtpExtras } from '../types';

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

const CORE_KINDS = ['mta', 'ses', 'resend', 'smtp'] as const;

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
	for (const kind of CORE_KINDS) {
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

describe('the seam stays closed', () => {
	it('governed dispatch names no relay provider kind', () => {
		// The point of P0.1: extras are the module's business, so the governed send
		// path must not know that `resend`, `smtp` or `ses` exist. `'mta'` still
		// appears there for provider-identity binding and MTA acceptance semantics
		// — a different concern, and one the plan leaves in place.
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '../../../delivery/governedDispatch.ts'),
			'utf8'
		);
		for (const kind of ['resend', 'smtp', 'ses'] as const) {
			expect(source).not.toContain(`'${kind}'`);
		}
	});
});
