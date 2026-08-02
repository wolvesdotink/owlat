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
 *   - ATTRIBUTION IS THE MOST RECENT MARKETING SEND A TRANSPORT ACTUALLY GOT,
 *     through the same join the shipped `campaigns.statsUnsubscribed`
 *     attribution now uses (`marketingSendAttribution.ts`). Transactional and
 *     agent 1:1 mail carries no RFC 8058 pair, and a `test` preview is not
 *     telemetry (`withoutTestSendEffects`), so neither may absorb an
 *     unsubscribe and put it into an arm denominator; an undispatched `queued`
 *     row may not either, or a blast's pre-created audience would swallow the
 *     signals answering the campaign before it.
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
import {
	latestAttributableAutomationSend,
	latestAttributableCampaignSend,
} from './marketingSendAttribution';
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
 * The most recent MARKETING send this contact received, across both send tables.
 *
 * Each table's candidate comes from the shared attribution join
 * (`marketingSendAttribution.ts`), which is also what the campaign-stats writer
 * asks; this function only has to order the two against each other.
 * `_creationTime` does that because it is the only stamp both tables always
 * carry (`transactionalSends.queuedAt` is optional) and because within one
 * contact it is exactly the order the index already returns rows in.
 */
async function latestMarketingSend(
	ctx: MutationCtx,
	contactId: Id<'contacts'>
): Promise<AttributableSend | null> {
	const campaignSend = await latestAttributableCampaignSend(ctx.db, contactId);
	const automationSend = await latestAttributableAutomationSend(ctx.db, contactId);

	const campaign: AttributableSend | null = campaignSend && {
		ref: { kind: 'campaign', id: campaignSend._id },
		createdAt: campaignSend._creationTime,
		unsubscribedAt: campaignSend.unsubscribedAt,
	};
	const automation: AttributableSend | null = automationSend && {
		ref: { kind: 'transactional', id: automationSend._id },
		createdAt: automationSend._creationTime,
		unsubscribedAt: automationSend.unsubscribedAt,
	};
	if (campaign === null) return automation;
	if (automation === null) return campaign;
	return automation.createdAt > campaign.createdAt ? automation : campaign;
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
