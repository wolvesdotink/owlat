import type { Doc } from '../../_generated/dataModel';
import type { Effect } from './effects';
import { contactEmailOf } from './lookups';
import type { EmailSendDoc, SendRef, SendStatus, TransactionalSendDoc } from './types';

export interface DeliveryObservationResult {
	patch: Record<string, unknown>;
	effects: Effect[];
	isNewObservation: boolean;
}

/**
 * Derive the effects shared by every trustworthy piece of delivery evidence.
 *
 * `deliveredAt` is the persisted idempotency key: provider acceptance, an open,
 * a click, or a complaint may arrive first, but exactly one of them records the
 * delivered denominator. Display status remains owned by the event reducer, so
 * a late provider acceptance never regresses opened/clicked/complained state.
 */
export function reduceDeliveryObservation(
	send: EmailSendDoc | TransactionalSendDoc,
	at: number,
	ref: SendRef,
	senderDomain: string | undefined,
	recipientContact: Doc<'contacts'> | null
): DeliveryObservationResult {
	if (send.deliveredAt !== undefined) {
		return { patch: {}, effects: [], isNewObservation: false };
	}

	const status = send.status as SendStatus;
	// Queue/worker failures and hard bounces are not delivery evidence. The
	// dispatcher validates the lifecycle edge before calling this reducer; this
	// guard makes the primitive safe if a future caller forgets that precondition.
	if (
		status === 'queued' ||
		status === 'failed' ||
		(status === 'bounced' && send.bounceType === 'hard')
	) {
		return { patch: {}, effects: [], isNewObservation: false };
	}

	const effects: Effect[] = [];
	if (recipientContact && (recipientContact.softBounceCount ?? 0) > 0) {
		effects.push({
			kind: 'contact_soft_bounce_count',
			contactId: recipientContact._id,
			count: 0,
		});
	}
	if (ref.kind === 'campaign') {
		effects.push({
			kind: 'campaign_stats_delivered',
			campaignId: (send as EmailSendDoc).campaignId,
			at,
		});
	}
	effects.push({ kind: 'daily_stats_bump', field: 'delivered', at });
	effects.push({
		kind: 'reputation_update',
		eventType: 'deliver',
		domain: senderDomain,
	});
	effects.push({
		kind: 'customer_webhook',
		spec: {
			literal: 'email.delivered',
			input: { email: contactEmailOf(send), at },
		},
	});

	return {
		patch: { deliveredAt: at },
		effects,
		isNewObservation: true,
	};
}
