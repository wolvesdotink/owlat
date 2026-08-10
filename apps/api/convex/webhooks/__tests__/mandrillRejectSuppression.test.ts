/**
 * Mandrill `reject` → suppression sync (plan D9 / piece P2.2).
 *
 * The property this suite exists for: DURING A MEASURED MIGRATION THE TWO ARMS
 * MUST SEND TO THE SAME POPULATION. Mandrill's reject list is years of
 * accumulated recipient truth that only the reference arm enforces, so every
 * hit it reports has to reach `blockedEmails` — and, through the shipped
 * mirror, the MTA's own backstop — or the own arm inherits bounces and
 * complaints the reference arm was silently spared, and the ramp controller
 * reads that as "our MTA is worse".
 *
 * The opposite failure is just as real and gets equal weight here: a reject
 * reason that describes OUR account (`invalid-sender`, `unsigned`,
 * `test-mode-limit`) must suppress NOBODY. A misconfigured sending domain
 * rejecting every message would otherwise blocklist a whole audience one send
 * at a time, permanently, with no operator action anywhere in the trail.
 *
 * Two halves, because the seam has two: the DISPOSITION (which reject reason
 * means what, proven through the real adapter mapping and the real dispatch
 * table) and the WRITER (`blockedEmails.addFromEvent`'s dedupe, mirror and
 * audit behaviour, proven against a real database).
 *
 * THE DISPOSITION HALF IS ALSO A PARITY SUITE. The policy used to live in one
 * vendor module the shared `email.failed` handler called by name; it now splits
 * across the Mandrill adapter (which reason is a recipient truth) and one
 * provider-agnostic effect table (what Owlat does about one). Every assertion
 * below is stated in terms of the mutations the dispatcher runs, so it holds
 * across that move unchanged — which is the point: a Mandrill deployment must
 * not be able to tell the difference.
 */

import { convexTest } from 'convex-test';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import {
	MANDRILL_REJECT_CODE_PREFIX,
	mapMandrillEvent,
	mandrillRejectSuppression,
} from '../adapters/mandrill';
import { dispatchInboundEvent } from '../dispatcher';

const RECIPIENT = 'blocked@example.com';

interface RunMutationCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

/** The generated function reference, as its stable `module:function` name. */
const fnName = (ref: unknown): string =>
	getFunctionName(ref as Parameters<typeof getFunctionName>[0]);

/**
 * A dispatcher context that records what it was asked to run.
 *
 * Calls are keyed by the REAL generated function name rather than through a
 * stringifying proxy mock of `_generated/api` (the older `sesDispatch.test.ts`
 * shape): this suite also drives the real backend below, and the two halves
 * cannot share a file if the generated api is mocked away.
 */
function makeCtx(): { ctx: ActionCtx; calls: RunMutationCall[] } {
	const calls: RunMutationCall[] = [];
	const ctx = {
		runMutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
			calls.push({ name: fnName(ref), args });
			return { ok: true };
		}),
		scheduler: { runAfter: vi.fn(async () => undefined) },
	} as unknown as ActionCtx;
	return { ctx, calls };
}

/** The event the real adapter produces for a reject with this reason. */
function rejectEvent(rejectReason: string | undefined, email: string | null = RECIPIENT) {
	const event = mapMandrillEvent({
		event: 'reject',
		ts: 1_770_000_000,
		msg: {
			_id: 'mandrill-msg-1',
			...(email === null ? {} : { email }),
			...(rejectReason === undefined ? {} : { reject_reason: rejectReason }),
		},
	});
	if (event?.kind !== 'email.failed') throw new Error('fixture did not map to email.failed');
	return event;
}

/** Every call the dispatcher made to the blocklist writer. */
const suppressions = (calls: readonly RunMutationCall[]) =>
	calls.filter((call) => call.name === fnName(internal.blockedEmails.addFromEvent));

const unsubscribes = (calls: readonly RunMutationCall[]) =>
	calls.filter(
		(call) => call.name === fnName(internal.delivery.unsubscribeQueries.processUnsubscribeByEmail)
	);

async function dispatchReject(
	rejectReason: string | undefined,
	email: string | null = RECIPIENT
): Promise<RunMutationCall[]> {
	const { ctx, calls } = makeCtx();
	await dispatchInboundEvent(ctx, rejectEvent(rejectReason, email));
	return calls;
}

describe('which reject reasons are recipient truths', () => {
	// The mapping is keyed on the code the ADAPTER builds, so the two are pinned
	// against each other rather than against a hand-written string: a change to
	// the normalizer that stopped producing this prefix would silently turn every
	// suppression below into a no-op.
	it('reads the code the adapter actually emits', () => {
		expect(rejectEvent('hard-bounce').errorCode).toBe(`${MANDRILL_REJECT_CODE_PREFIX}_HARD_BOUNCE`);
	});

	it.each([
		['hard-bounce', 'bounced', 'hard'],
		['soft-bounce', 'bounced', 'soft'],
		['bounce', 'bounced', 'hard'],
	])('suppresses %s as a %s bounce (%s)', async (reason, expected, bounceType) => {
		const calls = await dispatchReject(reason);
		expect(suppressions(calls)).toHaveLength(1);
		expect(suppressions(calls)[0]!.args).toMatchObject({
			email: RECIPIENT,
			reason: expected,
			bounceType,
			provenance: {
				provider: 'mandrill',
				source: 'webhook',
				evidence: rejectEvent(reason).errorCode,
			},
		});
	});

	it('suppresses a spam reject as a complaint, not a bounce', async () => {
		const calls = await dispatchReject('spam');
		expect(suppressions(calls)[0]!.args).toMatchObject({ reason: 'complained' });
		// A complaint carries no bounce classification — sending one would make the
		// MTA mirror describe a spam report as a mailbox failure.
		expect(suppressions(calls)[0]!.args['bounceType']).toBeUndefined();
	});

	// An operator (or an account rule) put this address on the list by hand. That
	// is a human decision, and `manual` is the reason class that says so on the
	// suppression screen and expires at the MTA backstop.
	it.each(['custom', 'rule'])('records an operator-curated %s entry as manual', async (reason) => {
		const calls = await dispatchReject(reason);
		expect(suppressions(calls)[0]!.args).toMatchObject({ reason: 'manual' });
		expect(suppressions(calls)[0]!.args['bounceType']).toBeUndefined();
	});

	// THE DOUBLE-HANDLING RESOLUTION. `unsub` arriving as a reject is the same
	// fact the adapter maps a first-class `unsub` EVENT to, and consent has a
	// whole accounting path (membership delete, opt-out stamp, campaign counter,
	// webhook fanout). A blocklist row would record the outcome and skip all of
	// it, so this reason routes to the unsubscribe path and NEVER to the writer.
	it('routes an unsub reject through the consent path instead of the blocklist', async () => {
		const calls = await dispatchReject('unsub');
		expect(suppressions(calls)).toHaveLength(0);
		expect(unsubscribes(calls)).toHaveLength(1);
		expect(unsubscribes(calls)[0]!.args).toEqual({ email: RECIPIENT });
	});

	// THE SENDER-SIDE REASONS. Every one of these says something about our
	// account, our sending domain or our message — none of them about the person.
	it.each(['invalid-sender', 'invalid', 'test-mode-limit', 'unsigned', 'some-future-reason'])(
		'suppresses nobody on a %s reject',
		async (reason) => {
			const calls = await dispatchReject(reason);
			expect(suppressions(calls)).toHaveLength(0);
			expect(unsubscribes(calls)).toHaveLength(0);
		}
	);

	it('suppresses nobody on a reject that names no reason at all', async () => {
		expect(suppressions(await dispatchReject(undefined))).toHaveLength(0);
	});

	it('suppresses nobody on a reject that names no address', async () => {
		expect(suppressions(await dispatchReject('hard-bounce', null))).toHaveLength(0);
	});

	// MOVED WITH THE CODE (was: "ignores a lookalike error code from another
	// provider", when the shared handler re-parsed `errorCode` and guarded itself
	// on `providerType === 'mandrill'`). The dispatcher no longer reads a vendor
	// code at all: it applies the suppression an ADAPTER minted. So the property
	// that replaces the identity guard is stronger and provider-agnostic — a
	// failure carrying a Mandrill-shaped code but no minted suppression, from any
	// provider, suppresses nobody.
	it('suppresses nobody on a lookalike error code no adapter minted a suppression for', async () => {
		const { ctx, calls } = makeCtx();
		const { suppression: _minted, ...lookalike } = rejectEvent('hard-bounce');
		await dispatchInboundEvent(ctx, { ...lookalike, providerType: 'ses' });
		expect(suppressions(calls)).toHaveLength(0);
		expect(unsubscribes(calls)).toHaveLength(0);
	});

	// The adapter is what decides, so the decision is asserted where it now lives.
	it('mints no suppression for an error code without the reject prefix', () => {
		expect(mandrillRejectSuppression('PROVIDER_ACCEPTANCE_UNCONFIRMED')).toBeUndefined();
		expect(mandrillRejectSuppression('MANDRILL_REJECT')).toBeUndefined();
	});

	// THE DATA, NOT THE DISPATCHER. Every consequence above is carried on the
	// event the adapter emitted; the shared table applies it without knowing which
	// provider minted it, which is what makes the next provider's suppression
	// policy a table in its own adapter rather than a line in the dispatcher.
	it('carries the whole decision on the event the adapter emits', () => {
		expect(rejectEvent('hard-bounce').suppression).toEqual({
			reason: 'hard_bounce',
			evidence: 'MANDRILL_REJECT_HARD_BOUNCE',
		});
		expect(rejectEvent('unsub').suppression).toEqual({
			reason: 'unsubscribed',
			evidence: 'MANDRILL_REJECT_UNSUB',
		});
		expect(rejectEvent('invalid-sender').suppression).toBeUndefined();
	});

	// The Send row still has to leave "sending" whatever the suppression decided,
	// and the suppression has to be the FIRST of the two: nothing in the
	// bookkeeping half may be the reason an address Mandrill refuses stays
	// mailable on ours.
	it('still fails the send, suppression first', async () => {
		const calls = await dispatchReject('hard-bounce');
		expect(calls.map((call) => call.name)).toEqual([
			fnName(internal.blockedEmails.addFromEvent),
			fnName(internal.delivery.sendLifecycle.transitionByProviderMessageId),
		]);
		expect(calls[1]!.args).toMatchObject({
			providerMessageId: 'mandrill-msg-1',
			transition: { to: 'failed', errorCode: 'MANDRILL_REJECT_HARD_BOUNCE' },
		});
	});
});

describe('the shared suppression writer', () => {
	const write = async (
		t: ReturnType<typeof convexTest>,
		args: Record<string, unknown> = {}
	): Promise<void> => {
		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: RECIPIENT,
			reason: 'bounced',
			bounceType: 'hard',
			provenance: { provider: 'mandrill', source: 'webhook', evidence: 'MANDRILL_REJECT_HARD' },
			...args,
		});
	};

	const rows = async (t: ReturnType<typeof convexTest>) =>
		await t.run(async (ctx) => await ctx.db.query('blockedEmails').collect());

	const auditRows = async (t: ReturnType<typeof convexTest>) =>
		await t.run(async (ctx) => await ctx.db.query('auditLogs').collect());

	const mirrorJobs = async (t: ReturnType<typeof convexTest>) =>
		await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter((job) =>
				job.name.includes('suppressionMirror')
			)
		);

	it('writes the row, the mirror and the audit entry', async () => {
		const t = convexTest(schema, modules);
		await write(t);

		expect(await rows(t)).toMatchObject([
			{ email: RECIPIENT, reason: 'bounced', bounceType: 'hard' },
		]);
		// The bounce classification reaches the MTA too: it is what makes the
		// backstop entry permanent rather than expiring.
		expect((await mirrorJobs(t))[0]?.args[0]).toMatchObject({
			email: RECIPIENT,
			reason: 'bounced',
			bounceType: 'hard',
		});
		const audit = await auditRows(t);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			action: 'blocklist.provider_suppressed',
			resource: 'blocklist',
			userId: 'system:mandrill_webhook',
			details: {
				email: RECIPIENT,
				reason: 'bounced',
				provider: 'mandrill',
				source: 'webhook',
				bounceType: 'hard',
				evidence: 'MANDRILL_REJECT_HARD',
			},
		});
	});

	// REPLAY IS THE NORMAL CASE, not an edge one: Mandrill redelivers a whole
	// batch when any part of the response disappoints it, and the signature
	// carries no timestamp for this layer to reject a repeat with.
	it('adds nothing on a replayed batch — no row, no mirror, no audit entry', async () => {
		const t = convexTest(schema, modules);
		await write(t);
		await write(t);
		await write(t);

		expect(await rows(t)).toHaveLength(1);
		expect(await mirrorJobs(t)).toHaveLength(1);
		expect(await auditRows(t)).toHaveLength(1);
	});

	// The same address arriving with an UPPERCASE spelling is the same person:
	// the writer normalizes before it looks, so a provider that echoes the
	// address as the sender typed it cannot create a second row.
	it('dedupes on the normalized address', async () => {
		const t = convexTest(schema, modules);
		await write(t);
		await write(t, { email: RECIPIENT.toUpperCase() });

		expect(await rows(t)).toHaveLength(1);
	});

	it('accepts the operator-curated manual reason', async () => {
		const t = convexTest(schema, modules);
		await write(t, { reason: 'manual', bounceType: undefined });

		expect(await rows(t)).toMatchObject([{ reason: 'manual' }]);
		expect((await mirrorJobs(t))[0]?.args[0]).toMatchObject({ reason: 'manual' });
	});

	it('mirrors a soft bounce as soft, so the backstop entry can expire', async () => {
		const t = convexTest(schema, modules);
		await write(t, { bounceType: 'soft' });

		expect((await mirrorJobs(t))[0]?.args[0]).toMatchObject({ bounceType: 'soft' });
	});

	// THE SHIPPED CALLERS ARE UNCHANGED. `complaintDispatch` and the lifecycle
	// effects pass no provenance and must keep writing exactly what they wrote
	// before this piece — a row and a mirror, and nothing in the audit trail.
	it('leaves a caller that names no provenance exactly as it was', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.blockedEmails.addFromEvent, {
			email: RECIPIENT,
			reason: 'complained',
		});

		expect(await rows(t)).toMatchObject([{ email: RECIPIENT, reason: 'complained' }]);
		expect(await mirrorJobs(t)).toHaveLength(1);
		expect(await auditRows(t)).toHaveLength(0);
	});
});
