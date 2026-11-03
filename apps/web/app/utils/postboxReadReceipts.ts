/**
 * What the reader says about the read receipts a sent message asked for: one
 * line per receipt that came back, and who has not sent one.
 *
 * Pure so the wording decisions are testable without mounting the reader.
 * Every line is a catalog key with its params, resolved by the component.
 */

/** One returned receipt, as `listThreadOutboundDelivery` returns it. */
export interface ReturnedReadReceipt {
	address: string;
	disposition: 'displayed' | 'deleted';
	isAutomatic: boolean;
	at: number;
}

export interface ReadReceiptRecord {
	requestedAt: number;
	returned: ReturnedReadReceipt[];
}

export interface ReadReceiptLine {
	address: string;
	key: string;
	at: number;
}

export interface ReadReceiptView {
	lines: ReadReceiptLine[];
	/** Recipients with no receipt yet, in dispatch order. */
	waiting: string[];
}

const KEY = 'components.postbox.postboxReadReceipts';

/**
 * Fold a message's receipt record and its recipients into the view. Receipts
 * are listed oldest first; recipients are compared case-insensitively and
 * listed once.
 */
export function readReceiptView(record: ReadReceiptRecord, recipients: string[]): ReadReceiptView {
	const lines = [...record.returned]
		.sort((a, b) => a.at - b.at)
		.map((receipt) => ({
			address: receipt.address,
			key: receipt.disposition === 'displayed' ? `${KEY}.readBy` : `${KEY}.deletedBy`,
			at: receipt.at,
		}));
	const answered = new Set(record.returned.map((r) => r.address.toLowerCase()));
	const seen = new Set<string>();
	const waiting: string[] = [];
	for (const address of recipients) {
		const key = address.trim().toLowerCase();
		if (!key || answered.has(key) || seen.has(key)) continue;
		seen.add(key);
		waiting.push(address);
	}
	return { lines, waiting };
}
