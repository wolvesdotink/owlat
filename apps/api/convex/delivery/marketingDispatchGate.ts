/**
 * Marketing dispatch gate (module) — the worker's last check before a
 * MARKETING envelope leaves: is the address suppressed, and may the contact
 * still receive marketing at all?
 *
 * Intake-time checks are not enough on their own. A campaign resolves its
 * audience once and may dispatch up to ~24h later (timezone path, rate-limited
 * queue); an automation Send sits in the transactional pool, and can be parked
 * by a deferral. A hard bounce, complaint or manual block (the blocklist), or a
 * global unsubscribe or contact deletion (`lib/marketingEligibility.ts`) landing
 * in that window must still stop the message. So must the contact leaving the
 * topic the mail is sent for (`topicIneligibility`, refused as
 * `topic_unsubscribed`):
 *   - an automation Send records its automation, and the topic is read from
 *     there (`automationTopicIneligibility`);
 *   - a campaign envelope whose audience is a topic carries its campaign, and
 *     the topic is read from the campaign's send job, the audience snapshot the
 *     walker resolved this envelope from (the campaign row when no job exists).
 *     A segment campaign has no topic and is checked as before: a segment
 *     selects from all contacts, so leaving some topic does not take a contact
 *     out of it.
 *
 * A pause pulls an automation's queued mail back. An automation Send goes out
 * only while its automation has stayed active since the Send was written
 * (`automationStayedActiveSince`). A pause, a revert to draft or a deletion
 * after that point withdraws it, and so does a pause that was resumed before
 * the worker got to the Send: whoever paused to fix the email must not see
 * the old copy go out once they resume. The rule needs no check of the email
 * step itself: steps can be edited, removed or retyped only in a draft, which
 * takes a pause first. The Send carries its composed content, so a template
 * edited while the automation stayed active does not change it. Mail the
 * built-in MTA already accepted or a relay already took is past this gate.
 *
 * Which envelopes are marketing:
 *   - every `campaign` envelope. A seed-probe shadow copy is addressed to an
 *     operator-owned seed mailbox, not the contact, so only its address is
 *     checked: neither the contact nor the topic.
 *   - a `transactional` envelope with `emailPurpose: 'marketing'` and a
 *     `sendId` — an automation email step.
 *
 * Real transactional mail with a Send (API template sends, agent and team
 * replies) is re-checked too, but only against the blocklist and on the
 * transactional scope it was admitted under (`lib/suppression.ts`): a hard
 * bounce, a complaint or a manual block that landed while it was held or
 * retried stops it; an unsubscribe or an `unengaged` suppression does not,
 * because neither stops a receipt. Member previews and seed probes are not
 * re-checked; they never gated on the blocklist.
 *
 * The same gate HOLDS marketing envelopes while the deployment's sending is
 * suspended or banned (`workspaces/abuseGate.ts:readSendingHold`). Mail that was
 * enqueued before the suspension, including a campaign's timezone groups and a
 * multi-day plan's earlier pages, must not leave while it lasts, and must not be
 * lost either: the worker returns a deferral that the completion re-enters.
 *
 * Point reads only: one `blockedEmails.by_email` lookup, one contact get and the
 * `instanceSettings` singleton, plus for an automation Send the Send, its
 * automation and the topic membership, and for a topic campaign its send job
 * and the topic membership. The automation read serves both the pause and the
 * topic check.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { isSuppressed } from '../lib/suppression';
import {
	automationTopicIneligibility,
	contactMarketingIneligibility,
	topicIneligibility,
	type MarketingIneligibility,
} from '../lib/marketingEligibility';
import { readSendingHold, SENDING_HOLD_RECHECK_MS } from '../workspaces/abuseGate';
import type { WorkerEnvelopeInput, WorkerRetryState } from './workerEnvelope';
import type { SendWorkerOutcome } from './workerOutcome';

/** Why the gate refuses an envelope, beside a blocklist hit (which carries none). */
export type MarketingDispatchRefusalReason = MarketingIneligibility | 'automation_paused';

/** The worker's pre-dispatch refusal (see {@link checkMarketingDispatch}). */
type MarketingDispatchRefusal = { kind: 'suppressed'; reason?: MarketingDispatchRefusalReason };

/**
 * Whether mail an automation queued at `queuedAt` may still go out: the
 * automation exists, is not deleted, is active, and its status has not changed
 * since. `statusChangedAt` moves on every pause and resume; a row not
 * transitioned since the field was added and still active was not paused
 * after any Send it could hold. `>=` because a pause in the same millisecond
 * as the Send's write committed after it (the intake refuses a paused
 * automation).
 */
export function automationStayedActiveSince(
	automation: Pick<Doc<'automations'>, 'status' | 'deletedAt' | 'statusChangedAt'> | null,
	queuedAt: number
): boolean {
	if (automation === null || automation.deletedAt !== undefined) return false;
	if (automation.status !== 'active') return false;
	return automation.statusChangedAt === undefined || automation.statusChangedAt < queuedAt;
}

/**
 * The topic a campaign was sent to, or `null` for a segment campaign. The send
 * job holds the audience the walker resolved every page from; the campaign row
 * answers only when no job exists. With neither, there is no topic to check.
 */
async function campaignTopicId(
	ctx: QueryCtx,
	campaignId: Id<'campaigns'>
): Promise<Id<'topics'> | null> {
	const job = await ctx.db
		.query('campaignSendJobs')
		.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
		.first();
	const audience = job?.audience ?? (await ctx.db.get(campaignId))?.audience;
	return audience?.kind === 'topic' ? audience.topicId : null;
}

/** What the worker's last gate answers for a marketing envelope, or `null` to send it. */
export type MarketingDispatchVerdict = MarketingDispatchRefusal | { kind: 'held' };

/**
 * The worker's `suppressed` outcome when a marketing envelope must not be
 * dispatched, else `null`. A blocklist hit carries no `reason` — the shape the
 * arm had before contact eligibility joined it.
 */
export const checkMarketingDispatch = internalQuery({
	args: {
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
		// The Send of an automation envelope, whose automation may belong to a
		// topic. Optional, so a worker built before it still gets an answer.
		sendId: v.optional(v.id('transactionalSends')),
		// The campaign of a campaign envelope that may have been sent to a topic.
		// Absent for a segment campaign and a seed probe, which have no topic to
		// check.
		topicCampaignId: v.optional(v.id('campaigns')),
		// Set for real transactional mail: the blocklist on that scope, nothing else.
		scope: v.optional(v.literal('transactional')),
	},
	handler: async (ctx, args): Promise<MarketingDispatchVerdict | null> => {
		// Suppression first: it is final, so a suppressed recipient is settled
		// now rather than held for days and refused afterwards.
		if (await isSuppressed(ctx, args.email, { scope: args.scope })) return { kind: 'suppressed' };
		// Real transactional mail gates on the blocklist alone: neither a
		// contact's marketing ineligibility nor a suspension of marketing sending
		// stops a receipt.
		if (args.scope === 'transactional') return null;
		const contact = args.contactId !== undefined ? await ctx.db.get(args.contactId) : undefined;
		if (contact !== undefined) {
			const reason = contactMarketingIneligibility(contact);
			if (reason !== null) return { kind: 'suppressed', reason };
		}
		const send = args.sendId !== undefined ? await ctx.db.get(args.sendId) : null;
		if (send?.automationId !== undefined) {
			// A missing row is an automation purged after its deletion.
			const automation = await ctx.db.get(send.automationId);
			if (!automationStayedActiveSince(automation, send._creationTime)) {
				return { kind: 'suppressed', reason: 'automation_paused' };
			}
			if (automation && contact) {
				const leftTopic = await automationTopicIneligibility(ctx, automation, contact);
				if (leftTopic !== null) return { kind: 'suppressed', reason: leftTopic.reason };
			}
		}
		if (args.topicCampaignId !== undefined && contact) {
			const topicId = await campaignTopicId(ctx, args.topicCampaignId);
			if (topicId !== null) {
				const reason = await topicIneligibility(ctx, contact, topicId);
				if (reason !== null) return { kind: 'suppressed', reason };
			}
		}
		return (await readSendingHold(ctx.db)) === null ? null : { kind: 'held' };
	},
});

/**
 * The deferral a held envelope returns. It spends no attempt (the attempt
 * number is passed on unchanged), so only the delivery deadline bounds it, and
 * the deadline counts from the first attempt or, for mail held before its first
 * dispatch, from the first hold. The idempotency key is the one the dispatch
 * would have minted, so the attempt that finally goes out is this send's own.
 *
 * `local`: the deployment holding its own mail says nothing about how
 * receivers see the sending identity, so the ramp's deferral gate ignores it.
 */
export function sendingHoldOutcome(input: {
	readonly envelopeInput: WorkerEnvelopeInput;
	readonly retryState: WorkerRetryState | undefined;
	readonly idempotencyKey: string;
	readonly now: number;
}): Extract<SendWorkerOutcome, { kind: 'deferred' }> {
	const { retryState } = input;
	return {
		kind: 'deferred',
		retryAfterMs: SENDING_HOLD_RECHECK_MS,
		deferralOrigin: 'local',
		hold: 'sending_suspended',
		envelopeInput: input.envelopeInput,
		retryState: {
			...retryState,
			attempt: retryState?.attempt ?? 1,
			startedAt: retryState?.startedAt ?? input.now,
			idempotencyKey: input.idempotencyKey,
		},
	};
}

/**
 * The address and contact the worker must pass to {@link checkMarketingDispatch}
 * before dispatching `envelope`, or `null` when the envelope is not marketing.
 */
export function marketingDispatchRecipient(envelope: WorkerEnvelopeInput): {
	email: string;
	contactId?: Id<'contacts'>;
	sendId?: Id<'transactionalSends'>;
	topicCampaignId?: Id<'campaigns'>;
} | null {
	if (envelope.kind === 'campaign') {
		if (envelope.seedProbeRef !== undefined) return { email: envelope.to };
		const contactId = envelope.contactInfo.contactId;
		// A segment campaign skips the read; an envelope that names no audience
		// type lets the gate read it from the campaign.
		const topicCampaignId = envelope.audienceType !== 'segment' ? envelope.campaignId : undefined;
		return {
			email: envelope.to,
			...(contactId !== undefined ? { contactId } : {}),
			...(topicCampaignId !== undefined ? { topicCampaignId } : {}),
		};
	}
	if (envelope.emailPurpose === 'marketing' && envelope.sendId !== undefined) {
		return {
			email: envelope.to,
			...(envelope.contactId !== undefined ? { contactId: envelope.contactId } : {}),
			sendId: envelope.sendId,
		};
	}
	return null;
}

/**
 * The recipient of a real transactional envelope that the worker re-checks
 * against the blocklist on the transactional scope, or `null` for marketing
 * mail (see {@link marketingDispatchRecipient}), member previews and seed probes.
 */
export function transactionalDispatchRecipient(
	envelope: WorkerEnvelopeInput
): { email: string; scope: 'transactional' } | null {
	if (envelope.kind !== 'transactional' || envelope.emailPurpose !== 'transactional') return null;
	if (envelope.sendId === undefined || envelope.seedProbeRef !== undefined) return null;
	if (envelope.deliveryDomain === 'member_test') return null;
	return { email: envelope.to, scope: 'transactional' };
}
