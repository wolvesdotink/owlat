import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { getFunctionName } from 'convex/server';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type {
	AcceptanceSemantics,
	MessageIdSource,
	SendProviderKind,
} from '../../lib/sendProviders/catalog';

const resolveLastMileRouting = vi.hoisted(() => vi.fn());
const sendProviderDispatch = vi.hoisted(() => vi.fn());
/**
 * The declaration the catalog accessors report, steerable per test so one send
 * can be replayed under semantics that deliberately disagree with its kind —
 * the only way to prove the boundary reads the catalog rather than the kind
 * name (plan D2). `null` is pass-through: every test that does not call
 * `declare()` sees the real catalog, and every test resets it afterwards.
 */
const declared = vi.hoisted(() => ({
	current: null as null | {
		acceptanceSemantics: AcceptanceSemantics;
		messageIdSource: MessageIdSource;
	},
}));

vi.mock('../lastMileRouting', () => ({ resolveLastMileRouting }));
vi.mock('../../lib/sendProviders/dispatch', () => ({ sendProviderDispatch }));
vi.mock('../../lib/sendProviders/catalog', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sendProviders/catalog')>();
	return {
		...actual,
		acceptanceSemanticsFor: (kind: SendProviderKind) =>
			declared.current?.acceptanceSemantics ?? actual.acceptanceSemanticsFor(kind),
		messageIdSourceFor: (kind: SendProviderKind) =>
			declared.current?.messageIdSource ?? actual.messageIdSourceFor(kind),
		// NOTHING ELSE IS REPLACED. `preassignsProviderMessageId` and
		// `takesCustodyOnAcceptance` take the DECLARATION rather than the kind, so
		// steering the two lookups above is enough and the real derivations run in
		// both modes — a copy of them here would keep passing after production's
		// rule tightened, which is precisely the regression this file exists to
		// catch.
	};
});

import { dispatchGovernedEmail } from '../governedDispatch';
import type { WorkerEnvelopeInput, WorkerRetryState } from '../workerEnvelope';
import type { Id } from '../../_generated/dataModel';

const runMutation = vi.fn().mockResolvedValue({ token: 'reentry-token', expiresAt: Date.now() });
const ctx = { runMutation } as unknown as ActionCtx;
// A REAL envelope, not a stub. The deferral and replay arms now carry it
// through a Convex validator (the worker action's `returns`, and the shape the
// completion callback matches against), so a partial fixture would prove a
// round trip the wire would refuse.
const envelopeInput: WorkerEnvelopeInput = {
	kind: 'campaign',
	to: 'recipient@example.com',
	from: 'sender@example.com',
	template: { subject: 'Subject', htmlContent: '<p>Body</p>' },
	contactInfo: { email: 'recipient@example.com' },
	emailSendId: 'send-row-1' as Id<'emailSends'>,
	organizationId: 'org-1',
};
const baseRequest = {
	envelopeInput,
	deliveryDomain: 'production' as const,
	messageType: 'campaign' as const,
	to: 'recipient@example.com',
	from: 'sender@example.com',
	organizationId: 'org-1',
	sendRef: { kind: 'campaign' as const, id: 'send-row-1' as never },
	message: {
		subject: 'Subject',
		html: '<p>Body</p>',
		text: 'Body',
	},
};

/** The identity-binding mutation, by REFERENCE — not by argument shape. */
const BIND_PROVIDER_IDENTITY = getFunctionName(
	internal.delivery.sendLifecycle.bindMtaProviderIdentity
);

/**
 * FILE-SCOPE, so a steered declaration can never outlive the test that set it:
 * every assertion outside `describe('reads the declared dispatch semantics, not
 * the kind')` reads the real catalog, whatever order tests are added in.
 */
afterEach(() => {
	declared.current = null;
});

describe('dispatchGovernedEmail', () => {
	afterEach(() => vi.useRealTimers());

	beforeEach(() => {
		resolveLastMileRouting.mockReset();
		sendProviderDispatch.mockReset();
		runMutation.mockClear();
	});

	it('returns a typed retry envelope without dispatching when routing defers', async () => {
		resolveLastMileRouting.mockResolvedValue({
			kind: 'defer',
			retryAfterMs: 30_000,
			origin: 'governed',
		});

		const result = await dispatchGovernedEmail(ctx, baseRequest);

		expect(resolveLastMileRouting).toHaveBeenCalledWith(ctx, {
			messageType: 'campaign',
			to: 'recipient@example.com',
			from: 'sender@example.com',
			providerType: undefined,
			ipPool: undefined,
			organizationId: 'org-1',
			idempotencyKey: 'send_send-row-1',
			workAttemptId: expect.any(String),
			routingReentryToken: 'reentry-token',
			startedAt: expect.any(Number),
			deliveryDomain: 'production',
			mtaReconciliation: false,
			// The durable Send id travels with the routing request so an
			// adaptive_mix cell dispatches on the arm the enqueue transaction
			// recorded for this recipient.
			sendId: 'send-row-1',
		});
		expect(sendProviderDispatch).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			kind: 'deferred',
			retryAfterMs: 30_000,
			envelopeInput,
			retryState: { attempt: 2, idempotencyKey: 'send_send-row-1' },
		});
	});

	it('binds the governed MTA route, lease, pool, and stable idempotency key', async () => {
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: { ipPool: 'campaign' },
			organizationId: 'org-1',
			routingLease: 'lease-1',
		});
		sendProviderDispatch.mockResolvedValue({
			result: { success: true, id: 'mta-dedup-sentinel' },
			providerType: 'mta',
			latencyMs: 12,
			attempts: 1,
		});

		const result = await dispatchGovernedEmail(ctx, baseRequest);

		expect(sendProviderDispatch).toHaveBeenCalledWith(
			ctx,
			'mta',
			{
				to: 'recipient@example.com',
				from: 'sender@example.com',
				replyTo: undefined,
				...baseRequest.message,
			},
			{
				messageId: 'send_send-row-1',
				workAttemptId: expect.any(String),
				routingReentryToken: 'reentry-token',
				organizationId: 'org-1',
				messageType: 'campaign',
				deliveryDomain: 'production',
				routingLease: 'lease-1',
				allowWarmupOverflow: false,
				ipPool: 'campaign',
				routingReentry: {
					envelopeInput,
					retryState: {
						attempt: 2,
						startedAt: expect.any(Number),
						idempotencyKey: 'send_send-row-1',
					},
				},
			}
		);
		expect(result).toEqual({
			kind: 'accepted',
			providerMessageId: 'send_send-row-1',
			providerType: 'mta',
			sendLatencyMs: 12,
			isCustodyHandoff: true,
		});
	});

	// G-02 — the envelope's engagement score is stamped onto MtaExtras. The
	// exact-match assertion above is the companion regression: with NO score on
	// the request the extras object is byte-for-byte what it always was.
	describe('engagementScore on MtaExtras', () => {
		async function extrasForScore(engagementScore: number | undefined) {
			runMutation
				.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
				.mockResolvedValueOnce({ ok: true });
			resolveLastMileRouting.mockResolvedValue({
				kind: 'ready',
				providerKind: 'mta',
				route: { ipPool: 'campaign' },
				organizationId: 'org-1',
				routingLease: 'lease-1',
			});
			sendProviderDispatch.mockResolvedValue({
				result: { success: true, id: 'mta-1' },
				providerType: 'mta',
				latencyMs: 4,
				attempts: 1,
			});

			await dispatchGovernedEmail(ctx, { ...baseRequest, engagementScore });

			return sendProviderDispatch.mock.calls[0]?.[3] as Record<string, unknown>;
		}

		it('stamps a scored recipient onto the extras', async () => {
			expect((await extrasForScore(87))['engagementScore']).toBe(87);
		});

		it('keeps a 0 ("cold") score — it is a real band, not an absence', async () => {
			const extras = await extrasForScore(0);
			expect(extras['engagementScore']).toBe(0);
			expect('engagementScore' in extras).toBe(true);
		});

		it('OMITS the key for an unscored recipient (not 0, not null)', async () => {
			const extras = await extrasForScore(undefined);
			expect('engagementScore' in extras).toBe(false);
			// Every shipped extra survives untouched.
			expect(extras).toMatchObject({
				messageId: 'send_send-row-1',
				workAttemptId: expect.any(String),
				routingReentryToken: 'reentry-token',
				organizationId: 'org-1',
				messageType: 'campaign',
				deliveryDomain: 'production',
				routingLease: 'lease-1',
				allowWarmupOverflow: false,
				ipPool: 'campaign',
			});
		});

		it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101])(
			'treats the hostile score %p as unknown rather than clamping it',
			async (score) => {
				expect('engagementScore' in (await extrasForScore(score))).toBe(false);
			}
		);
	});

	it('preserves the original retry key when the provider rejects a stale lease', async () => {
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		const startedAt = Date.now() - 100;
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: null,
			organizationId: 'org-1',
			routingLease: 'lease-2',
		});
		sendProviderDispatch.mockResolvedValue({
			result: {
				success: false,
				errorCode: 'ROUTING_DEFERRED',
				errorMessage: 'lease changed',
				retryAfterMs: 5_000,
			},
			providerType: 'mta',
			latencyMs: 3,
			attempts: 1,
		});

		const result = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: {
				attempt: 2,
				startedAt,
				idempotencyKey: 'send_original',
			},
		});

		expect(result).toMatchObject({
			kind: 'deferred',
			retryAfterMs: 5_000,
			// The MTA withdrew its own lease at enqueue: governance about this
			// identity, so gate 2 may count it.
			deferralOrigin: 'governed',
			retryState: {
				attempt: 3,
				startedAt,
				idempotencyKey: 'send_original',
			},
		});
	});

	// ISSUE #505. Same 409 status, same wait, same bounded re-entry — and the
	// opposite claim: the MTA could not read back a lease record it wrote, so no
	// receiver refused anything and nothing was decided about this identity.
	// Marking it `governed` let a lease-store outage spend gate 2's 10% ceiling
	// and walk a cell towards its 25% halt.
	it('defers an unreadable-lease answer as our own fault, not the identity’s', async () => {
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		const startedAt = Date.now() - 100;
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: null,
			organizationId: 'org-1',
			routingLease: 'lease-3',
		});
		sendProviderDispatch.mockResolvedValue({
			result: {
				success: false,
				errorCode: 'ROUTING_LEASE_UNREADABLE',
				errorMessage: 'Routing lease could not be read; resolve again',
				retryAfterMs: 5_000,
			},
			providerType: 'mta',
			latencyMs: 3,
			attempts: 1,
		});

		expect(
			await dispatchGovernedEmail(ctx, {
				...baseRequest,
				retryState: { attempt: 2, startedAt, idempotencyKey: 'send_original' },
			})
		).toMatchObject({
			kind: 'deferred',
			retryAfterMs: 5_000,
			deferralOrigin: 'local',
			retryState: { attempt: 3, startedAt, idempotencyKey: 'send_original' },
		});
	});

	it('replays a request-never-arrived ambiguity with the same MTA-only work identity', async () => {
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token-1', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ token: 'reentry-token-2', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: { ipPool: 'campaign' },
			organizationId: 'org-1',
			routingLease: 'lease-1',
		});
		sendProviderDispatch
			.mockResolvedValueOnce({
				result: {
					success: false,
					errorCode: 'SERVER_ERROR',
					errorMessage: 'request outcome unknown',
					acceptanceUnknown: true,
				},
				providerType: 'mta',
				latencyMs: 10,
				attempts: 3,
			})
			.mockResolvedValueOnce({
				result: { success: true, id: 'send_send-row-1' },
				providerType: 'mta',
				latencyMs: 5,
				attempts: 1,
			});

		const unknown = await dispatchGovernedEmail(ctx, baseRequest);
		expect(unknown).toMatchObject({
			kind: 'acceptanceUnknown',
			retryState: { acceptanceReconciliation: true, workAttemptId: expect.any(String) },
		});
		if (unknown.kind !== 'acceptanceUnknown') throw new Error('expected ambiguity');
		const accepted = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: unknown.retryState,
		});

		const firstExtras = sendProviderDispatch.mock.calls[0]![3] as { workAttemptId: string };
		const secondExtras = sendProviderDispatch.mock.calls[1]![3] as { workAttemptId: string };
		expect(secondExtras.workAttemptId).toBe(firstExtras.workAttemptId);
		expect(resolveLastMileRouting.mock.calls[1]![1]).toMatchObject({
			workAttemptId: firstExtras.workAttemptId,
			mtaReconciliation: true,
		});
		expect(accepted).toMatchObject({ kind: 'accepted', isCustodyHandoff: true });
	});

	it('holds a send under a safety pause without spending its routing attempts', async () => {
		// Eight 60-second attempts would terminalize the send ~7 minutes in —
		// inside a single deliverability signal's own 10-minute freshness window,
		// so the "pause" would still destroy the mail, just later.
		resolveLastMileRouting.mockResolvedValue({
			kind: 'defer',
			retryAfterMs: 600_000,
			isPolicyHold: true,
			origin: 'local',
		});

		const result = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: { attempt: 4, startedAt: Date.now(), idempotencyKey: 'send_send-row-1' },
		});

		expect(result).toMatchObject({
			kind: 'deferred',
			retryAfterMs: 600_000,
			// The origin travels to the completion callback, which is the only place
			// gate 2's numerator can be written from — a hold this deployment chose
			// is not the destination throttling it.
			deferralOrigin: 'local',
			retryState: { attempt: 4 },
		});
	});

	it('still spends an attempt on ordinary routing churn', async () => {
		resolveLastMileRouting.mockResolvedValue({
			kind: 'defer',
			retryAfterMs: 30_000,
			origin: 'governed',
		});

		const result = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: { attempt: 4, startedAt: Date.now(), idempotencyKey: 'send_send-row-1' },
		});

		expect(result).toMatchObject({
			kind: 'deferred',
			deferralOrigin: 'governed',
			retryState: { attempt: 5 },
		});
	});

	it('gives a routing re-entry successor a work attempt of its own', async () => {
		// A re-entry successor that inherited `workAttemptId` would dedupe against
		// the intake receipt of the job that just surrendered ownership: the MTA
		// answers `deduplicated: true`, Convex marks the Send accepted for
		// delivery, no MTA work exists, and the Send waits `queued` for a webhook
		// that can never arrive. The handoff is always pre-SMTP, so the
		// reconciliation the flag was waiting on is resolved too.
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: { ipPool: 'campaign' },
			routingLease: { token: 'lease-1' },
		});
		sendProviderDispatch.mockResolvedValue({
			result: { success: true, id: 'send_send-row-1' },
			providerType: 'mta',
			latencyMs: 5,
			attempts: 1,
		});

		await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: {
				attempt: 2,
				startedAt: Date.now(),
				idempotencyKey: 'send_send-row-1',
				workAttemptId: 'work-attempt-from-the-unknown-acceptance',
				acceptanceReconciliation: true,
			},
		});

		// This attempt still reuses the identity it is reconciling…
		const extras = sendProviderDispatch.mock.calls[0]![3] as {
			workAttemptId: string;
			routingReentry: { retryState: Record<string, unknown> };
		};
		expect(extras.workAttemptId).toBe('work-attempt-from-the-unknown-acceptance');

		// …but what it hands a successor must not carry that identity onward, and
		// the snapshot digest must cover the same bytes the MTA will echo.
		const snapshotArgs = runMutation.mock.calls[0]![1] as {
			retryState: Record<string, unknown>;
		};
		expect(Object.keys(snapshotArgs.retryState).sort()).toEqual([
			'attempt',
			'idempotencyKey',
			'startedAt',
		]);
		expect(extras.routingReentry.retryState).toEqual(snapshotArgs.retryState);
	});

	it.each([
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS - 1, accepted: true },
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS, accepted: false },
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 1, accepted: false },
	])(
		'enforces the cumulative delivery deadline at offset $offset',
		async ({ offset, accepted }) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
			const now = Date.now();
			resolveLastMileRouting.mockResolvedValue({
				kind: 'defer',
				retryAfterMs: 30_000,
				origin: 'governed',
			});
			const request = {
				...baseRequest,
				retryState: {
					attempt: 2,
					startedAt: now - offset,
					idempotencyKey: 'send_original',
				},
			};

			if (accepted) {
				await expect(dispatchGovernedEmail(ctx, request)).resolves.toMatchObject({
					kind: 'deferred',
					retryState: { startedAt: now - offset },
				});
				expect(resolveLastMileRouting).toHaveBeenCalledOnce();
			} else {
				await expect(dispatchGovernedEmail(ctx, request)).rejects.toThrow(
					'Governed delivery deadline expired.'
				);
				expect(resolveLastMileRouting).not.toHaveBeenCalled();
			}
		}
	);
	describe('relay arm — the custom return path (plan G-08)', () => {
		function relayRouting(relayReturnPathHost: string | undefined) {
			resolveLastMileRouting.mockResolvedValue({
				kind: 'ready',
				providerKind: 'smtp',
				route: null,
				organizationId: 'org-1',
				relayReturnPathHost,
			});
			sendProviderDispatch.mockResolvedValue({
				result: { success: true, id: 'relay-message-id' },
				providerType: 'smtp',
				latencyMs: 7,
				attempts: 1,
			});
		}

		function dispatchedExtras(): unknown {
			// Indexed rather than `.at(-1)`: convex/tsconfig.json's `lib` stops at
			// ES2021, so `Array.prototype.at` is not in the type set here.
			const calls = sendProviderDispatch.mock.calls;
			return calls[calls.length - 1]?.[3];
		}

		it('passes the authorised return-path host through to SmtpExtras', async () => {
			relayRouting('bounces.example.com');
			await dispatchGovernedEmail(ctx, baseRequest);
			expect(sendProviderDispatch).toHaveBeenCalledWith(ctx, 'smtp', expect.anything(), {
				returnPathHost: 'bounces.example.com',
			});
			expect(dispatchedExtras()).toEqual({ returnPathHost: 'bounces.example.com' });
		});

		it('fails closed to the composer envelope sender when no host was authorised', async () => {
			relayRouting(undefined);
			await dispatchGovernedEmail(ctx, baseRequest);
			expect(dispatchedExtras()).toEqual({});
		});

		it('reads the capability from the ROUTING result — no extra query per send', async () => {
			// The routing pass already ran a query; a second round trip on the hot
			// send path to read a deployment-scoped fact would be pure overhead. The
			// ctx here deliberately has NO runQuery, so a reintroduced read throws.
			relayRouting('bounces.example.com');
			await expect(dispatchGovernedEmail(ctx, baseRequest)).resolves.toMatchObject({
				kind: 'accepted',
				providerType: 'smtp',
			});
			expect((ctx as unknown as { runQuery?: unknown }).runQuery).toBeUndefined();
		});
	});

	/**
	 * AN AMBIGUOUS TIMEOUT ON A RELAY (plan D4).
	 *
	 * The MTA reconciles by REPLAYING the attempt — its idempotency key is the MTA
	 * message id, so a repeat costs nothing. Mandrill's `send-raw` has no
	 * idempotency surface at all, so the same replay would double-deliver. Before
	 * this branch existed the ambiguity fell through to `throw`, `completeSend`
	 * terminalized the row `failed`/`WORKPOOL_FAILED`, and `failed` is terminal —
	 * the row claimed a definite non-delivery for a message that may have been
	 * delivered and closed itself to every later transition.
	 */
	describe('ambiguous acceptance on a non-MTA transport', () => {
		function ambiguousRouting(providerKind: 'smtp' | 'mandrill') {
			resolveLastMileRouting.mockResolvedValue({
				kind: 'ready',
				providerKind,
				route: null,
				organizationId: 'org-1',
			});
			sendProviderDispatch.mockResolvedValue({
				result: {
					success: false,
					errorCode: 'AMBIGUOUS_TIMEOUT',
					errorMessage: 'Mandrill send timed out',
					acceptanceUnknown: true,
				},
				providerType: providerKind,
				latencyMs: 30_000,
				attempts: 1,
			});
		}

		it('parks a feedback-capable relay send instead of terminalizing it', async () => {
			ambiguousRouting('mandrill');
			const startedAt = Date.now() - 5_000;

			const result = await dispatchGovernedEmail(ctx, {
				...baseRequest,
				retryState: { attempt: 1, startedAt, idempotencyKey: 'send_send-row-1' },
			});

			expect(result).toEqual({
				kind: 'awaitingFeedback',
				providerType: 'mandrill',
				startedAt,
				retryState: { attempt: 1, startedAt, idempotencyKey: 'send_send-row-1' },
			});
		});

		it('carries NOTHING a caller could re-dispatch from', async () => {
			// D4: the lost response may sit on top of an accepted and delivered
			// message. The absence of an envelope and of a provider message id is the
			// structural guarantee — not a comment asking the callback to behave.
			ambiguousRouting('mandrill');
			const result = await dispatchGovernedEmail(ctx, baseRequest);
			expect('envelopeInput' in result).toBe(false);
			expect('providerMessageId' in result).toBe(false);
			expect('retryAfterMs' in result).toBe(false);
			expect(sendProviderDispatch).toHaveBeenCalledOnce();
		});

		it('does not park a transport with no feedback channel to wait for', async () => {
			// A bring-your-own SMTP relay reports nothing out of band
			// (`hasProviderFeedback: false`), so parking it would only delay the same
			// answer by the delivery deadline. Unchanged: it throws.
			ambiguousRouting('smtp');
			await expect(dispatchGovernedEmail(ctx, baseRequest)).rejects.toThrow(
				'Mandrill send timed out'
			);
		});
	});
});

/**
 * THE GOVERNED BOUNDARY ASKS THE CATALOG, NOT THE KIND (plan P0.1 / D2).
 *
 * Four behaviours used to be spelled `providerKind === 'mta'` in
 * `governedDispatch.ts`: the pre-dispatch identity binding, the message-id
 * substitution, `isCustodyHandoff`, and the replay-reconciliation arm of an
 * ambiguous acceptance. Each case below drives a send whose DECLARED semantics
 * contradict its kind — custody on a relay, none on the MTA — so the suite fails
 * against the identity checks and passes only against declarations.
 *
 * It shares the harness above deliberately. Two harnesses for one function
 * drift: the suite above is the one that pins the full `resolveLastMileRouting`
 * argument shape, and a change to that call must keep satisfying both halves at
 * once rather than whichever file the author happened to open.
 */
describe('reads the declared dispatch semantics, not the kind', () => {
	const IDEMPOTENCY_KEY = 'send_send-row-1';
	const SEND_REF = baseRequest.sendRef;

	function declare(acceptanceSemantics: AcceptanceSemantics, messageIdSource: MessageIdSource) {
		declared.current = { acceptanceSemantics, messageIdSource };
	}

	function routeTo(providerKind: SendProviderKind) {
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind,
			route: null,
			organizationId: 'org-1',
		});
	}

	function providerAnswers(providerType: SendProviderKind, result: Record<string, unknown>) {
		sendProviderDispatch.mockResolvedValue({ result, providerType, latencyMs: 9, attempts: 1 });
	}

	/**
	 * The arguments of every call to the identity-binding mutation, matched on
	 * the FUNCTION REFERENCE. Matching on "the call that carries a
	 * providerMessageId" would keep passing if the boundary swapped in a
	 * different mutation, which is the one thing this assertion is for.
	 */
	function identityBindings(): unknown[] {
		return runMutation.mock.calls
			.filter((call) => getFunctionName(call[0]) === BIND_PROVIDER_IDENTITY)
			.map((call) => call[1]);
	}

	beforeEach(() => {
		declared.current = null;
		resolveLastMileRouting.mockReset();
		sendProviderDispatch.mockReset();
		runMutation.mockReset();
		runMutation.mockImplementation(async (ref: unknown) =>
			getFunctionName(ref as Parameters<typeof getFunctionName>[0]) === BIND_PROVIDER_IDENTITY
				? { ok: true }
				: { token: 'reentry-token', expiresAt: Date.now() }
		);
	});

	// Restores the module-level default the suite above relies on, so this block
	// stays movable and order-independent.
	afterEach(() => {
		runMutation.mockReset();
		runMutation.mockResolvedValue({ token: 'reentry-token', expiresAt: Date.now() });
	});

	describe('a transport that DECLARES custody — proven on a relay kind', () => {
		beforeEach(() => {
			declare('accepted', 'idempotency-key');
			routeTo('smtp');
		});

		it('binds the pre-assigned identity before crossing the network', async () => {
			providerAnswers('smtp', { success: true, id: 'relay-assigned-id' });

			await dispatchGovernedEmail(ctx, baseRequest);

			expect(identityBindings()).toEqual([{ send: SEND_REF, providerMessageId: IDEMPOTENCY_KEY }]);
		});

		it('refuses to send when the binding is rejected', async () => {
			// `identity_conflict` means this Send is already bound to a DIFFERENT
			// provider message id — a re-dispatch of mail that already left. Logging
			// and sending anyway would re-mail the recipient, so the boundary throws
			// before the network crossing.
			runMutation.mockImplementation(async (ref: unknown) =>
				getFunctionName(ref as Parameters<typeof getFunctionName>[0]) === BIND_PROVIDER_IDENTITY
					? { ok: false, reason: 'identity_conflict' }
					: { token: 'reentry-token', expiresAt: Date.now() }
			);
			providerAnswers('smtp', { success: true, id: 'relay-assigned-id' });

			// The wording still names the MTA because it names the MUTATION that
			// rejected (`bindMtaProviderIdentity`), which is itself still MTA-shaped
			// — item 2 of the PREREQUISITES note on `AcceptanceSemantics`. Both move
			// in the same change; this pin is the reminder that they must.
			await expect(dispatchGovernedEmail(ctx, baseRequest)).rejects.toThrow(
				'Unable to bind MTA provider identity: identity_conflict'
			);
			expect(sendProviderDispatch).not.toHaveBeenCalled();
		});

		it('records OUR id, not the one the response carried', async () => {
			providerAnswers('smtp', { success: true, id: 'a-dedup-sentinel' });

			expect(await dispatchGovernedEmail(ctx, baseRequest)).toEqual({
				kind: 'accepted',
				providerMessageId: IDEMPOTENCY_KEY,
				providerType: 'smtp',
				sendLatencyMs: 9,
				isCustodyHandoff: true,
			});
		});

		it('replays an ambiguous acceptance instead of parking it', async () => {
			providerAnswers('smtp', {
				success: false,
				errorCode: 'AMBIGUOUS_TIMEOUT',
				errorMessage: 'request outcome unknown',
				acceptanceUnknown: true,
			});

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			expect(result).toMatchObject({
				kind: 'acceptanceUnknown',
				providerMessageId: IDEMPOTENCY_KEY,
				workAttemptId: expect.any(String),
				envelopeInput,
				retryState: { acceptanceReconciliation: true },
			});
			// The park arm is the OTHER answer to the same ambiguity; a custody
			// transport must not take it, or the reconciliation never happens.
			expect(result.kind).not.toBe('awaitingFeedback');
		});
	});

	describe('a transport that declares NO custody — proven on the MTA kind', () => {
		beforeEach(() => {
			declare('unknown-on-timeout', 'provider');
			routeTo('mta');
		});

		it('binds no identity — the id does not exist until the response carries it', async () => {
			providerAnswers('mta', { success: true, id: 'provider-assigned-id' });

			await dispatchGovernedEmail(ctx, baseRequest);

			expect(identityBindings()).toEqual([]);
		});

		it('records the provider id and claims no acceptance', async () => {
			providerAnswers('mta', { success: true, id: 'provider-assigned-id' });

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			// STATED, not inferred from a missing key: `sendCompletion` switches on
			// `kind` and then reads this boolean, so "no custody" has to be said out
			// loud rather than left to the absence of a marker.
			expect(result).toEqual({
				kind: 'accepted',
				providerMessageId: 'provider-assigned-id',
				providerType: 'mta',
				sendLatencyMs: 9,
				isCustodyHandoff: false,
			});
		});

		it('parks an ambiguous acceptance on the feedback channel instead of replaying it', async () => {
			providerAnswers('mta', {
				success: false,
				errorCode: 'AMBIGUOUS_TIMEOUT',
				errorMessage: 'request outcome unknown',
				acceptanceUnknown: true,
			});

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			expect(result).toEqual({
				kind: 'awaitingFeedback',
				providerType: 'mta',
				startedAt: expect.any(Number),
				retryState: expect.objectContaining({ idempotencyKey: IDEMPOTENCY_KEY }),
			});
			// The park arm hands the retry state back UNMARKED: a reconciliation flag
			// here would send the next attempt down the replay path this transport
			// has no idempotency surface for.
			expect(
				(result as { retryState: WorkerRetryState }).retryState.acceptanceReconciliation
			).toBeUndefined();
		});
	});

	/**
	 * TWO FIELDS, TWO BEHAVIOURS — steered apart.
	 *
	 * The two blocks above move both declarations together, so every behaviour
	 * there correlates with BOTH flags and a boundary that conflated them would
	 * still pass. This one splits the pair: the id is ours (so the identity IS
	 * bound and substituted) while acceptance is unknown-on-timeout (so nothing is
	 * accepted and the ambiguity PARKS rather than replays). Any single predicate
	 * driving all four behaviours fails at least one case here.
	 *
	 * `CoreSendProviderCatalogEntry` deliberately forbids this pairing for a kind
	 * that ships in this repo — see the union's doc block — but a bundled plugin
	 * entry is untyped and can present it, and the widening the doc block
	 * describes must stay a type change rather than a behaviour change. Steering
	 * the accessors is how that stays true without shipping such a kind.
	 */
	describe('a transport whose declarations are MIXED — our id, no custody', () => {
		beforeEach(() => {
			// Contradicts the MTA on the acceptance half only: a kind whose feedback
			// channel exists (`hasProviderFeedback: true`), so the park arm is
			// reachable and the assertion is about custody rather than about having
			// nowhere to park.
			declare('unknown-on-timeout', 'idempotency-key');
			routeTo('mta');
		});

		it('binds the pre-assigned identity — that follows the id, not the custody', async () => {
			providerAnswers('mta', { success: true, id: 'provider-assigned-id' });

			await dispatchGovernedEmail(ctx, baseRequest);

			expect(identityBindings()).toEqual([{ send: SEND_REF, providerMessageId: IDEMPOTENCY_KEY }]);
		});

		it('records OUR id and still claims no acceptance', async () => {
			providerAnswers('mta', { success: true, id: 'a-dedup-sentinel' });

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			expect(result).toEqual({
				kind: 'accepted',
				providerMessageId: IDEMPOTENCY_KEY,
				providerType: 'mta',
				sendLatencyMs: 9,
				isCustodyHandoff: false,
			});
		});

		it('parks an ambiguous acceptance — a pre-assigned id is not permission to replay', async () => {
			providerAnswers('mta', {
				success: false,
				errorCode: 'AMBIGUOUS_TIMEOUT',
				errorMessage: 'request outcome unknown',
				acceptanceUnknown: true,
			});

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			expect(result).toEqual({
				kind: 'awaitingFeedback',
				providerType: 'mta',
				startedAt: expect.any(Number),
				retryState: expect.objectContaining({ idempotencyKey: IDEMPOTENCY_KEY }),
			});
			// Knowing the id says nothing about whether the intake is re-askable:
			// only the acceptance declaration does, and it said no.
			expect(
				(result as { retryState: WorkerRetryState }).retryState.acceptanceReconciliation
			).toBeUndefined();
		});
	});

	describe('the shipped declarations keep the shipped behaviour', () => {
		it('the own MTA still binds, substitutes, and reports acceptance', async () => {
			routeTo('mta');
			providerAnswers('mta', { success: true, id: 'mta-dedup-sentinel' });

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			expect(identityBindings()).toEqual([{ send: SEND_REF, providerMessageId: IDEMPOTENCY_KEY }]);
			expect(result).toEqual({
				kind: 'accepted',
				providerMessageId: IDEMPOTENCY_KEY,
				providerType: 'mta',
				sendLatencyMs: 9,
				isCustodyHandoff: true,
			});
		});

		it('a relay still records the id its send produced, unbound and unaccepted', async () => {
			routeTo('smtp');
			providerAnswers('smtp', { success: true, id: 'relay-message-id' });

			const result = await dispatchGovernedEmail(ctx, baseRequest);

			expect(identityBindings()).toEqual([]);
			expect(result).toEqual({
				kind: 'accepted',
				providerMessageId: 'relay-message-id',
				providerType: 'smtp',
				sendLatencyMs: 9,
				isCustodyHandoff: false,
			});
		});
	});
});
