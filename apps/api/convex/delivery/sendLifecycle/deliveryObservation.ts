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
 * Whether an authenticated remote-acceptance timestamp is compatible with the
 * persisted lifecycle chronology. Arrival order is irrelevant: an acceptance
 * observed before a later terminal event remains valid, while a terminal event
 * that truly predates acceptance contradicts it. Missing terminal timestamps
 * are malformed legacy evidence and fail closed.
 */
export function canAttributeRemoteAcceptance(
	send: EmailSendDoc | TransactionalSendDoc,
	acceptedAt: number
): boolean {
	if (send.deliveredAt !== undefined) return true;
	const status = send.status as SendStatus;
	if (status === 'queued') return false;
	if (status === 'failed') {
		return send.failedAt !== undefined && acceptedAt <= send.failedAt;
	}
	if (status === 'bounced') {
		return send.bouncedAt !== undefined && acceptedAt <= send.bouncedAt;
	}
	return true;
}

/**
 * Derive the effects shared by every trustworthy piece of delivery evidence.
 *
 * `deliveredAt` is the persisted idempotency key: provider acceptance, an open,
 * a click, or a complaint may arrive first, but exactly one of them records the
 * delivered denominator. Display status remains owned by the event reducer, so
 * a late provider acceptance never regresses advanced or terminal state.
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

	// A queued row cannot have reached remote acceptance. Terminal chronology is
	// checked by canAttributeRemoteAcceptance before this reducer is called.
	if ((send.status as SendStatus) === 'queued') {
		return { patch: {}, effects: [], isNewObservation: false };
	}

	const effects: Effect[] = [];
	const status = send.status as SendStatus;
	const terminalAt =
		status === 'bounced' ? send.bouncedAt : status === 'failed' ? send.failedAt : undefined;
	// Delivery normally clears prior soft-bounce recovery state. A remote
	// acceptance replayed after a newer terminal event still counts toward the
	// truthful denominator, but must not erase the terminal event's contact state.
	const isAcceptanceBeforeTerminal = terminalAt !== undefined && at <= terminalAt;
	if (
		recipientContact &&
		(recipientContact.softBounceCount ?? 0) > 0 &&
		!isAcceptanceBeforeTerminal
	) {
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
