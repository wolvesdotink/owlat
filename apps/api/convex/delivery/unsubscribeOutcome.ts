/**
 * The `unsubscribed` transport outcome — the standalone twin's complaint proxy
 * (plan D5 / D10).
 *
 * Every other outcome event is a property of ONE MESSAGE'S TRANSPORT, so the
 * Send lifecycle emits it next to the shipped counter it must agree with. An
 * unsubscribe is not: it arrives on a public, CONTACT-keyed one-click endpoint
 * that carries no send id at all. This module is the missing join — contact →
 * the marketing send the unsubscribe answers → that send's `sendAssignments`
 * row → the (cell, arm) counter.
 *
 * WHY IT IS NOT OPTIONAL. `UNSUBSCRIBE_PROXY_SPEC` (`ramp/trailingBaselineGates
 * .ts`) reads `summary.unsubscribeRate` as gate 3's complaint proxy on every
 * deployment with no complaint feedback loop, and `relativeCeilingIsMeasurable`
 * refuses a zero trailing baseline. With no writer for the counter that rate is
 * derived from, gate 3 holds at `insufficient_data` forever — and a hold
 * outranks a pass in `aggregateRampGates`, so the standalone twin could never
 * advance a share.
 *
 * THREE CONSTRAINTS, each of which is why a line below exists:
 *
 *   - ATTRIBUTION IS THE MOST RECENT MARKETING SEND, the same rule the shipped
 *     `campaigns.statsUnsubscribed` attribution already applies. Transactional
 *     and agent 1:1 mail carries no RFC 8058 pair, and a `test` preview is not
 *     telemetry (`withoutTestSendEffects`), so neither may absorb an
 *     unsubscribe and put it into an arm denominator.
 *   - ONE UNSUBSCRIBE PER SEND. `unsubscribedAt` on the send row is the
 *     uniqueness gate, exactly as `openedAt` is inside `reduceOpened`: a mail
 *     client that POSTs the one-click target twice, or a contact who
 *     re-subscribes and leaves again, must not bump the numerator twice. The
 *     rate is denominated on `delivered`, and a numerator that can outrun its
 *     denominator is how the proxy gate comes to disagree with the dashboard.
 *   - OFF THE SYNCHRONOUS PATH. Scheduled by the subscription module, never
 *     called inline, for the same reason `recordCampaignUnsubscribe` is: the
 *     RFC 8058 response must not be gated on an OCC retry of a shared outcome
 *     shard during a post-blast unsubscribe burst.
 *
 * FAIL-SOFT, like the rest of the outcome path: a contact with no attributable
 * send, or a send outside the experiment, records NOTHING and says why.
 * Measurement degrades; the unsubscribe itself has already been applied.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { resolveNow } from '../lib/clock';
import { applyEffects, transportOutcomeEffect } from './sendLifecycle/effects';
import type { SendRef } from './sendLifecycle/types';

/** Why an unsubscribe did not reach a counter — returned, never thrown. */
export type RecordUnsubscribeOutcomeResult =
	| 'recorded'
	| 'no_marketing_send'
	| 'already_attributed';

/** The send an unsubscribe is attributed to, plus the state of its gate. */
interface AttributableSend {
	readonly ref: SendRef;
	/** When creation ordered it against the other table's candidate. */
	readonly createdAt: number;
	readonly unsubscribedAt: number | undefined;
}

/**
 * How far back through a contact's NON-CAMPAIGN sends the automation candidate
 * is looked for.
 *
 * `transactionalSends` mixes marketing drips with password resets, receipts and
 * agent replies, and a filtered `.first()` would read every one of them for a
 * contact who has received transactional mail and never a drip — an unbounded
 * per-contact read on a table nothing prunes. An unsubscribe answers a RECENT
 * message; a drip buried under this many later transactional messages is not the
 * one being answered, and the campaign candidate below still applies.
 */
export const AUTOMATION_LOOKBACK_SENDS = 25;

/**
 * The most recent MARKETING send this contact received, across both send tables.
 *
 * Two contact-leading index reads, both bounded — one row from `emailSends`,
 * `AUTOMATION_LOOKBACK_SENDS` from `transactionalSends`. `_creationTime` orders
 * the two candidates against each other because it is the only stamp both tables
 * always carry (`transactionalSends.queuedAt` is optional) and because within one
 * contact it is exactly the order the index already returns rows in.
 *
 * `kind: 'automation'` is the marketing boundary on the second table: a drip
 * carries the one-click pair (`buildTransactionalListUnsubscribe`), while a
 * transactional API send, an agent reply and a member-only `test` preview do not
 * — attributing an unsubscribe to one of those would move a cell's counter for a
 * message that could not have produced it.
 */
async function latestMarketingSend(
	ctx: MutationCtx,
	contactId: Id<'contacts'>
): Promise<AttributableSend | null> {
	const campaignSend = await ctx.db
		.query('emailSends')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.order('desc')
		.first();
	const recentNonCampaign = await ctx.db
		.query('transactionalSends')
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.order('desc')
		.take(AUTOMATION_LOOKBACK_SENDS);
	const automationSend = recentNonCampaign.find((send) => send.kind === 'automation');

	const candidates: AttributableSend[] = [];
	if (campaignSend) {
		candidates.push({
			ref: { kind: 'campaign', id: campaignSend._id },
			createdAt: campaignSend._creationTime,
			unsubscribedAt: campaignSend.unsubscribedAt,
		});
	}
	if (automationSend) {
		candidates.push({
			ref: { kind: 'transactional', id: automationSend._id },
			createdAt: automationSend._creationTime,
			unsubscribedAt: automationSend.unsubscribedAt,
		});
	}
	return candidates.reduce<AttributableSend | null>(
		(newest, candidate) =>
			newest === null || candidate.createdAt > newest.createdAt ? candidate : newest,
		null
	);
}

/**
 * Attribute one contact's unsubscribe to a send and bump that send's (cell,
 * arm) counter.
 *
 * Scheduled from the subscription module's per-call effect bundle, which is
 * what decides WHICH unsubscribe sources count (a recipient reaching for the
 * link, never an operator's bulk removal).
 */
export const recordUnsubscribeOutcome = internalMutation({
	args: { contactId: v.id('contacts'), at: v.optional(v.number()) },
	handler: async (ctx, args): Promise<RecordUnsubscribeOutcomeResult> => {
		const now = resolveNow(args.at);
		const send = await latestMarketingSend(ctx, args.contactId);
		// A contact who never received marketing mail (an import, a form signup
		// that unsubscribed from the preference page before the first send) has
		// nothing to attribute to. Not an error: there is no denominator to join.
		if (send === null) return 'no_marketing_send';
		if (send.unsubscribedAt !== undefined) return 'already_attributed';

		// Stamp BEFORE recording. The stamp is the gate, and a redelivered
		// one-click POST must find it set whatever the recorder then decides —
		// including "no assignment row", which records nothing but is still a
		// processed unsubscribe for this send.
		await ctx.db.patch(send.ref.id, { unsubscribedAt: now });
		// Through the lifecycle's own effect runner, so the outcome is written by
		// the ONE writer every other event goes through: it resolves the cell, the
		// arm and the calibration flag from the send's assignment row, and it
		// degrades to a warning rather than failing this mutation.
		await applyEffects(ctx, [transportOutcomeEffect(send.ref, 'unsubscribed', now)]);
		return 'recorded';
	},
});
