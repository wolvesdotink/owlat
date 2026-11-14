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
 * in that window must still stop the message.
 *
 * Which envelopes are marketing:
 *   - every `campaign` envelope. A seed-probe shadow copy is addressed to an
 *     operator-owned seed mailbox, not the contact, so only its address is
 *     checked.
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
 * `instanceSettings` singleton.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { isSuppressed } from '../lib/suppression';
import {
	loadContactMarketingIneligibility,
	type MarketingIneligibility,
} from '../lib/marketingEligibility';
import { readSendingHold, SENDING_HOLD_RECHECK_MS } from '../workspaces/abuseGate';
import type { WorkerEnvelopeInput, WorkerRetryState } from './workerEnvelope';
import type { SendWorkerOutcome } from './workerOutcome';

/** The worker's pre-dispatch refusal (see {@link checkMarketingDispatch}). */
type MarketingDispatchRefusal = { kind: 'suppressed'; reason?: MarketingIneligibility };

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
		if (args.contactId !== undefined) {
			const reason = await loadContactMarketingIneligibility(ctx, args.contactId);
			if (reason !== null) return { kind: 'suppressed', reason };
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
export function marketingDispatchRecipient(
	envelope: WorkerEnvelopeInput
): { email: string; contactId?: Id<'contacts'> } | null {
	if (envelope.kind === 'campaign') {
		const contactId =
			envelope.seedProbeRef === undefined ? envelope.contactInfo.contactId : undefined;
		return { email: envelope.to, ...(contactId !== undefined ? { contactId } : {}) };
	}
	if (envelope.emailPurpose === 'marketing' && envelope.sendId !== undefined) {
		return {
			email: envelope.to,
			...(envelope.contactId !== undefined ? { contactId: envelope.contactId } : {}),
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
