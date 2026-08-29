/**
 * The delivery strip's derivation (plan idea 1) — one row per recipient of a
 * message WE sent, plus the resend target set.
 *
 * Pure and DOM-free so the honesty-critical decisions (which rows are failures,
 * which addresses a resend should go to, whether the strip may collapse to a
 * single "delivered" line) are testable without mounting a Convex-backed
 * component. `PostboxDeliveryStrip.vue` is only the paint job.
 *
 * Every line is a catalog key or a `{key, params}` pair, resolved by the
 * component — module scope never calls `useI18n`.
 */

import type { HealthTone } from '~/utils/healthTone';
import type { LocalizedText } from '~/utils/readinessGate';
import { explainBounce, type BounceExplanation } from '~/utils/postboxBounceCatalog';

/** Per-recipient state, exactly as `mailMessages.outbound.recipients[].state`. */
export type DeliveryRecipientState = 'queued' | 'sent' | 'bounced' | 'failed';

/**
 * One recipient's stored delivery record. Structural on purpose: the Convex
 * return type of `mail.mailbox.messages.listThreadOutboundDelivery` satisfies it
 * without this pure module importing the backend's shape.
 */
export interface DeliveryRecipient {
	idx: number;
	address: string;
	state: DeliveryRecipientState;
	sentAt?: number;
	acceptedAt?: number;
	bouncedAt?: number;
	failedAt?: number;
	bounceMessage?: string;
	errorCode?: string;
}

export interface OutboundDelivery {
	state: 'queued' | 'sent' | 'bounced' | 'failed' | 'partial';
	recipients: DeliveryRecipient[];
}

export interface DeliveryRow {
	idx: number;
	address: string;
	state: DeliveryRecipientState;
	tone: HealthTone;
	icon: string;
	/**
	 * The moment this row's state is timestamped by, or null when nothing
	 * terminal has happened yet. A `sent` row prefers `acceptedAt` — the remote
	 * side taking the message is stronger evidence than our own handoff — and
	 * falls back to `sentAt`.
	 */
	at: number | null;
	/** The row's short status word. */
	label: LocalizedText;
	/**
	 * The plain-language explanation for a failure (idea 2's catalog), or null on
	 * a row that has not failed.
	 */
	explanation: BounceExplanation | null;
	/** The receiver's own wire text, kept as evidence under the explanation. */
	rawDetail: string | null;
}

export interface DeliveryStripView {
	rows: DeliveryRow[];
	/** Recipients that ended in a terminal failure, in row order. */
	failedAddresses: string[];
	/** True when every recipient took the message and nothing is outstanding. */
	isAllDelivered: boolean;
	/** True while at least one recipient has no terminal outcome yet. */
	isPending: boolean;
	/** The strip container's tone: the worst tone any row carries. */
	tone: HealthTone;
}

const KEY = 'shared.postboxDeliveryStrip';

const ROW_ICON: Record<DeliveryRecipientState, string> = {
	queued: 'lucide:clock',
	sent: 'lucide:check',
	bounced: 'lucide:x',
	failed: 'lucide:x',
};

const ROW_TONE: Record<DeliveryRecipientState, HealthTone> = {
	queued: 'neutral',
	sent: 'success',
	bounced: 'error',
	failed: 'error',
};

/** Worst-wins, so one bounce colours the strip even among nine deliveries. */
const TONE_RANK: Record<HealthTone, number> = { neutral: 0, success: 1, warning: 2, error: 3 };

function rowLabel(recipient: DeliveryRecipient): LocalizedText {
	if (recipient.state === 'sent') {
		// Say "delivered" only when the receiving side actually took it. Our own
		// handoff to the MTA is not the same claim, and asserting it would be the
		// exact lie this strip exists to end.
		return recipient.acceptedAt !== undefined ? `${KEY}.row.delivered` : `${KEY}.row.sent`;
	}
	if (recipient.state === 'queued') return `${KEY}.row.queued`;
	return `${KEY}.row.notDelivered`;
}

function rowTimestamp(recipient: DeliveryRecipient): number | null {
	switch (recipient.state) {
		case 'sent':
			return recipient.acceptedAt ?? recipient.sentAt ?? null;
		case 'bounced':
			return recipient.bouncedAt ?? null;
		case 'failed':
			return recipient.failedAt ?? null;
		default:
			return null;
	}
}

function toDeliveryRow(recipient: DeliveryRecipient): DeliveryRow {
	const isFailure = recipient.state === 'bounced' || recipient.state === 'failed';
	const explanation = isFailure
		? explainBounce({
				bounceMessage: recipient.bounceMessage,
				errorCode: recipient.errorCode,
			})
		: null;
	return {
		idx: recipient.idx,
		address: recipient.address,
		state: recipient.state,
		// A failure's tone comes from the catalog, so a greylist-shaped deferral
		// never paints the same red as a rejected sending identity.
		tone: explanation ? explanation.tone : ROW_TONE[recipient.state],
		icon: ROW_ICON[recipient.state],
		at: rowTimestamp(recipient),
		label: rowLabel(recipient),
		explanation,
		rawDetail: recipient.bounceMessage?.trim() || null,
	};
}

/**
 * Fold one message's stored `outbound` object into the strip's view model.
 *
 * Row order is the dispatch order (`idx`), NOT failures-first: the strip sits
 * under a message whose To/Cc line the reader already printed in that order, and
 * reshuffling it would make a two-recipient send hard to follow. The failure
 * stands out by colour and by carrying the only explanation.
 */
export function deliveryStripView(delivery: OutboundDelivery): DeliveryStripView {
	const rows = [...delivery.recipients]
		.sort((a, b) => a.idx - b.idx)
		.map((recipient) => toDeliveryRow(recipient));
	const failedAddresses = rows
		.filter((row) => row.state === 'bounced' || row.state === 'failed')
		.map((row) => row.address);
	const isPending = rows.some((row) => row.state === 'queued');
	return {
		rows,
		failedAddresses,
		isAllDelivered: rows.length > 0 && rows.every((row) => row.state === 'sent'),
		isPending,
		tone: rows.reduce<HealthTone>(
			(worst, row) => (TONE_RANK[row.tone] > TONE_RANK[worst] ? row.tone : worst),
			'neutral'
		),
	};
}

/**
 * The recipients a "resend to the failed ones only" action should target:
 * deduplicated (a To+Cc collision on one address is one resend) and
 * lowercase-compared, but returned in their original spelling.
 *
 * Deliberately EVERY failed recipient, not just the retryable ones. A user who
 * has since fixed the setup a DMARC rejection complained about must still be
 * able to resend; the row above the button already says what the failure was and
 * whether waiting alone will help.
 */
export function resendTargets(view: DeliveryStripView): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const address of view.failedAddresses) {
		const key = address.trim().toLowerCase();
		if (key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		out.push(address);
	}
	return out;
}

/**
 * Should the strip render at all?
 *
 * A single-recipient message that simply went out is the overwhelmingly common
 * case, and a green row under every sent mail is noise nobody asked for. The
 * strip earns its space when there is something to say: a failure, a recipient
 * still in flight, or more than one recipient (where "who got it?" is a real
 * question).
 */
export function isDeliveryStripWorthShowing(view: DeliveryStripView): boolean {
	return view.failedAddresses.length > 0 || view.isPending || view.rows.length > 1;
}
