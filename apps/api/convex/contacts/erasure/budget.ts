/**
 * The per-transaction allowance of one contact-erasure step.
 *
 * Convex caps what a single transaction may read and write, and one contact's
 * history has no fixed size, so every erasure phase draws on this budget and
 * stops when it runs out; the walker persists where it stopped and continues in
 * the next transaction. Rows are counted exactly; bytes are the encoded size of
 * the documents read, which is what the platform limit is about.
 *
 * The byte limit is enforced BEFORE a read, not after it: a read of `n` rows
 * may cost up to `n` maximum-size documents, so `chunk()` never asks for more
 * rows than the remaining byte allowance could hold at that size. Charging
 * after the fact is too late — the platform fails the transaction while the
 * oversized batch is still being fetched, and the retry fetches it again.
 *
 * The one exception is the transaction's first row of progress: it is always
 * allowed, so a transaction whose re-reads (the parent a phase resumes under,
 * a probe) already filled the allowance still moves the walk forward.
 */

import { getConvexSize, type Value } from 'convex/values';

/** Largest read a phase makes in one go. */
export const ERASURE_READ_CHUNK = 32;

/** Convex's per-document size limit: the most one row can cost to read. */
const MAX_DOCUMENT_BYTES = 1024 * 1024;

/**
 * Charged per document on top of its encoded value size, for the index entry
 * and framing the value size leaves out.
 */
const DOCUMENT_OVERHEAD_BYTES = 64;

export class ErasureBudget {
	private rowsSpent = 0;
	private bytesSpent = 0;

	constructor(
		private readonly maxRows: number,
		private readonly maxBytes: number
	) {}

	/** No limit — the whole erasure in the caller's one transaction. */
	static unlimited(): ErasureBudget {
		return new ErasureBudget(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	}

	/**
	 * Out of rows, or — once a row has been processed — without room for one
	 * more maximum-size document.
	 */
	get isExhausted(): boolean {
		if (this.rowsSpent >= this.maxRows) return true;
		return this.rowsSpent > 0 && this.affordableRows() < 1;
	}

	get rows(): number {
		return this.rowsSpent;
	}

	get bytes(): number {
		return this.bytesSpent;
	}

	/**
	 * How many rows the next read may ask for: no more than the rows left, and
	 * no more than the byte allowance left could hold if every row were a
	 * maximum-size document. Always at least one.
	 */
	chunk(max: number = ERASURE_READ_CHUNK): number {
		return Math.max(1, Math.min(max, this.maxRows - this.rowsSpent, this.affordableRows()));
	}

	/**
	 * Rows a read may ask for when the platform bounds its bytes itself
	 * (`maximumBytesRead` on a page): the rows left, at most `max`, at least one.
	 */
	pageRows(max: number): number {
		return Math.max(1, Math.min(max, this.maxRows - this.rowsSpent));
	}

	/** Bytes left in the allowance, at least one; infinite for an unlimited budget. */
	get bytesLeft(): number {
		return Math.max(1, this.maxBytes - this.bytesSpent);
	}

	/** Account for one document read and deleted or patched — a row of progress. */
	charge(doc: unknown): void {
		this.rowsSpent += 1;
		this.bytesSpent += estimateDocumentBytes(doc);
	}

	/**
	 * Account for a document read that is not itself progress: a probe, the
	 * parent a phase re-reads to resume under it, a row a delegated helper
	 * fetched. It costs bytes, not a row.
	 */
	chargeRead(doc: unknown): void {
		this.bytesSpent += estimateDocumentBytes(doc);
	}

	/** Account for rows a delegated helper touched without handing them back. */
	chargeRows(count: number): void {
		this.rowsSpent += count;
	}

	private affordableRows(): number {
		return Math.floor((this.maxBytes - this.bytesSpent) / MAX_DOCUMENT_BYTES);
	}
}

/**
 * The stored size of a Convex document, in bytes: Convex's own measure (UTF-8
 * encoded strings and field names, 9 bytes per number), plus per-document
 * overhead. UTF-16 `length` would under-count every non-ASCII character.
 */
export function estimateDocumentBytes(doc: unknown): number {
	return getConvexSize(doc as Value) + DOCUMENT_OVERHEAD_BYTES;
}
