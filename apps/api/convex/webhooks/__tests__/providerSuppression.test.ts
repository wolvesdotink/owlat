/**
 * THE PROVIDER-AGNOSTIC SUPPRESSION LANE.
 *
 * The property this suite exists for: a provider the dispatcher has never heard
 * of must be able to express a complete suppression policy — permanent and
 * recoverable mailbox failures, complaints, hand-curated entries, and a
 * departure that belongs on the consent path instead of the blocklist — as
 * DATA, and get the same behaviour the incumbent's hand-written sync had.
 *
 * So every provider below is a made-up one. `acme-relay` is a synthetic core
 * adapter's kind and `plugin.acme.mail` a bundled transport's; neither appears
 * anywhere in `dispatcher.ts`, `providerSuppression.ts` or the catalog, and no
 * line was added to any of them to make these pass. That is the whole claim: the
 * next provider with a suppression list is a table in its own adapter, not a
 * branch in the shared dispatch table.
 *
 * The plugin half goes through the REAL host revalidation
 * (`parsePluginFeedbackEvents`) rather than hand-built events, because a
 * vocabulary the host cannot express on the plugin lane is one that quietly
 * ranks a bundled transport below the core adapters.
 */

import { convexTest } from 'convex-test';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import { dispatchInboundEvent } from '../dispatcher';
import { parsePluginFeedbackEvents } from '../pluginFeedbackEvents';
import { applyProviderSuppression } from '../providerSuppression';
import { PROVIDER_SUPPRESSION_REASONS, type ProviderSuppressionReason } from '../types';

const PLUGIN_KIND = 'plugin.acme.mail';
const RECIPIENT = 'blocked@example.com';

const fnName = (ref: unknown): string =>
	getFunctionName(ref as Parameters<typeof getFunctionName>[0]);

interface RunMutationCall {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

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

const blocks = (calls: readonly RunMutationCall[]) =>
	calls.filter((call) => call.name === fnName(internal.blockedEmails.addFromEvent));

const unsubscribes = (calls: readonly RunMutationCall[]) =>
	calls.filter(
		(call) => call.name === fnName(internal.delivery.unsubscribeQueries.processUnsubscribeByEmail)
	);

/** The events the host derives from one plugin batch, revalidated for real. */
function pluginSuppression(reason: ProviderSuppressionReason) {
	const [event] = parsePluginFeedbackEvents(
		[{ kind: 'provider_suppressed', recipient: RECIPIENT, reason, at: Date.now() }],
		PLUGIN_KIND
	);
	if (event?.kind !== 'email.provider_suppressed') throw new Error('fixture did not map');
	return event;
}

describe('portable provider suppression effects', () => {
	it.each([
		['invalid_recipient', 'bounced', 'hard'],
		['recipient_rejected', 'manual', undefined],
		['recipient_blacklisted', 'manual', undefined],
	] as const)('maps %s to the bounded host reason', async (wireReason, reason, bounceType) => {
		const runMutation = vi.fn().mockResolvedValue(null);
		await applyProviderSuppression({ runMutation } as never, {
			kind: 'email.provider_suppressed',
			recipient: 'blocked@example.com',
			at: Date.now(),
			reason: wireReason,
			providerType: 'plugin.acme.mail',
		});
		expect(runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				email: 'blocked@example.com',
				reason,
				...(bounceType ? { bounceType } : {}),
				provenance: {
					provider: 'plugin.acme.mail',
					source: 'webhook',
					evidence: `PROVIDER_SUPPRESSED_${wireReason.toUpperCase()}`,
				},
			})
		);
	});
});

describe('a provider nothing was written for expresses its whole policy as data', () => {
	// Every member of the vocabulary, on the plugin lane, through the real
	// dispatch table. The three original members keep the exact effects the
	// shipped suite pinned above; the widened ones are what let a suppression
	// list carry more than "we refused this address".
	it.each([
		['invalid_recipient', 'bounced', 'hard'],
		['hard_bounce', 'bounced', 'hard'],
		['soft_bounce', 'bounced', 'soft'],
		['spam_complaint', 'complained', undefined],
		['recipient_rejected', 'manual', undefined],
		['recipient_blacklisted', 'manual', undefined],
		['operator_suppressed', 'manual', undefined],
	] as const)('blocks %s as %s', async (reason, blockReason, bounceType) => {
		const { ctx, calls } = makeCtx();
		await dispatchInboundEvent(ctx, pluginSuppression(reason));

		expect(blocks(calls)).toHaveLength(1);
		expect(blocks(calls)[0]!.args).toMatchObject({
			email: RECIPIENT,
			reason: blockReason,
			provenance: {
				provider: PLUGIN_KIND,
				source: 'webhook',
				evidence: `PROVIDER_SUPPRESSED_${reason.toUpperCase()}`,
			},
		});
		// A complaint or a curated entry carries NO bounce classification: sending
		// one would make the MTA mirror describe it as a mailbox failure.
		expect(blocks(calls)[0]!.args['bounceType']).toBe(bounceType);
	});

	// The same resolution the incumbent's `unsub` reject gets, available to
	// everyone: consent has an accounting path (membership delete, opt-out stamp,
	// campaign counter, webhook fanout) and a blocklist row would record the
	// outcome while skipping all of it.
	it('routes a departure through the consent path instead of the blocklist', async () => {
		const { ctx, calls } = makeCtx();
		await dispatchInboundEvent(ctx, pluginSuppression('unsubscribed'));

		expect(blocks(calls)).toHaveLength(0);
		expect(unsubscribes(calls)).toHaveLength(1);
		expect(unsubscribes(calls)[0]!.args).toEqual({ email: RECIPIENT });
	});

	it('decides an effect for every member of the vocabulary', () => {
		// The effect table is `Record<ProviderSuppressionReason, …>`, so a member
		// added without a decision is a compile error rather than an address that
		// quietly stops being suppressed. This asserts the other half: that the
		// cases above are the whole vocabulary and not a subset of it.
		const covered = new Set<ProviderSuppressionReason>([
			'invalid_recipient',
			'hard_bounce',
			'soft_bounce',
			'spam_complaint',
			'recipient_rejected',
			'recipient_blacklisted',
			'operator_suppressed',
			'unsubscribed',
		]);
		expect([...PROVIDER_SUPPRESSION_REASONS].filter((reason) => !covered.has(reason))).toEqual([]);
	});

	// THE OTHER LANE. A provider whose suppression arrives ON its terminal
	// failure (the incumbent's shape: one event that ends the send AND names the
	// refused address) needs no dispatcher line either — its adapter mints the
	// same normalized fact, and the shared handler applies it before it does the
	// bookkeeping.
	it('applies a failure-borne suppression from an unknown provider, suppression first', async () => {
		const { ctx, calls } = makeCtx();
		await dispatchInboundEvent(ctx, {
			kind: 'email.failed',
			providerMessageId: 'acme-1',
			at: Date.now(),
			errorCode: 'ACME_SUPPRESSED_SOFT',
			errorMessage: 'Acme refused the message',
			providerType: 'acme-relay',
			recipient: RECIPIENT,
			suppression: { reason: 'soft_bounce', evidence: 'ACME_SUPPRESSED_SOFT' },
		});

		expect(calls.map((call) => call.name)).toEqual([
			fnName(internal.blockedEmails.addFromEvent),
			fnName(internal.delivery.sendLifecycle.transitionByProviderMessageId),
		]);
		expect(calls[0]!.args).toMatchObject({
			email: RECIPIENT,
			reason: 'bounced',
			bounceType: 'soft',
			// The PROVIDER's own code, not the host's rendering of it: an operator
			// reading the suppression screen sees what the provider actually said.
			provenance: { provider: 'acme-relay', source: 'webhook', evidence: 'ACME_SUPPRESSED_SOFT' },
		});
	});

	it('suppresses nobody on a terminal failure carrying no suppression', async () => {
		const { ctx, calls } = makeCtx();
		await dispatchInboundEvent(ctx, {
			kind: 'email.failed',
			providerMessageId: 'acme-2',
			at: Date.now(),
			errorCode: 'ACME_SUPPRESSED_SOFT',
			errorMessage: 'Acme refused the message',
			providerType: 'acme-relay',
			recipient: RECIPIENT,
		});

		expect(blocks(calls)).toHaveLength(0);
		expect(unsubscribes(calls)).toHaveLength(0);
	});

	it('suppresses nobody when the provider names no address', async () => {
		const { ctx, calls } = makeCtx();
		await dispatchInboundEvent(ctx, {
			kind: 'email.failed',
			providerMessageId: 'acme-3',
			at: Date.now(),
			errorCode: 'ACME_SUPPRESSED_HARD',
			errorMessage: 'Acme refused the message',
			providerType: 'acme-relay',
			suppression: { reason: 'hard_bounce' },
		});

		expect(blocks(calls)).toHaveLength(0);
	});
});

describe('a redelivered batch changes nothing', () => {
	/**
	 * An `ActionCtx` backed by the convex-test harness, so the dispatcher's
	 * `ctx.runMutation` reaches the REAL mutations and writes real rows. Replay is
	 * the normal case for a webhook — a provider redelivers a whole batch when any
	 * part of the response disappoints it — so the no-op has to hold through the
	 * writer, the MTA mirror schedule and the audit trail, none of which a
	 * recording double would show.
	 */
	function actionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
		const harness = t as unknown as {
			mutation: (reference: unknown, args: unknown) => Promise<unknown>;
		};
		return {
			runMutation: (reference: unknown, args: unknown) => harness.mutation(reference, args),
		} as unknown as ActionCtx;
	}

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

	it('writes one row, one mirror and one audit entry however often it arrives', async () => {
		const t = convexTest(schema, modules);
		const event = pluginSuppression('hard_bounce');
		for (let i = 0; i < 3; i++) await dispatchInboundEvent(actionCtx(t), event);

		expect(await rows(t)).toMatchObject([
			{ email: RECIPIENT, reason: 'bounced', bounceType: 'hard' },
		]);
		expect(await mirrorJobs(t)).toHaveLength(1);
		expect(await auditRows(t)).toMatchObject([
			{
				action: 'blocklist.provider_suppressed',
				details: { provider: PLUGIN_KIND, evidence: 'PROVIDER_SUPPRESSED_HARD_BOUNCE' },
			},
		]);
	});

	// The soft classification survives the round trip: it is what makes the MTA
	// backstop entry expire rather than being permanent.
	it('keeps a recoverable failure recoverable', async () => {
		const t = convexTest(schema, modules);
		const event = pluginSuppression('soft_bounce');
		await dispatchInboundEvent(actionCtx(t), event);
		await dispatchInboundEvent(actionCtx(t), event);

		expect(await rows(t)).toMatchObject([{ reason: 'bounced', bounceType: 'soft' }]);
		expect((await mirrorJobs(t))[0]?.args[0]).toMatchObject({ bounceType: 'soft' });
	});
});
