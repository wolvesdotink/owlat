/**
 * The per-transaction allowance of one contact-erasure step.
 *
 * Convex caps what a single transaction may read and write, and one contact's
 * history has no fixed size, so every erasure phase draws on this budget and
 * stops when it runs out; the walker persists where it stopped and continues in
 * the next transaction. Rows are counted exactly; bytes are an estimate from
 * the documents read, which is what the platform limit is about.
 *
 * Reads happen in chunks, so a transaction can overshoot by at most one chunk.
 * The limits in `walker.ts` leave that headroom below the platform ceiling.
 */

/** Largest read a phase makes in one go. */
export const ERASURE_READ_CHUNK = 32;

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

	get isExhausted(): boolean {
		return this.rowsSpent >= this.maxRows || this.bytesSpent >= this.maxBytes;
	}

	get rows(): number {
		return this.rowsSpent;
	}

	/** How many rows the next read may ask for (always at least one). */
	chunk(max: number = ERASURE_READ_CHUNK): number {
		return Math.max(1, Math.min(max, this.maxRows - this.rowsSpent));
	}

	/** Account for one document read (and deleted or patched). */
	charge(doc: unknown): void {
		this.rowsSpent += 1;
		this.bytesSpent += approximateSize(doc);
	}

	/** Account for rows a delegated helper touched without handing them back. */
	chargeRows(count: number): void {
		this.rowsSpent += count;
	}
}

/** A cheap upper-bound-ish size of a Convex value, in bytes. */
function approximateSize(value: unknown): number {
	if (value === null || value === undefined) return 1;
	switch (typeof value) {
		case 'string':
			return value.length + 2;
		case 'number':
		case 'bigint':
			return 8;
		case 'boolean':
			return 1;
	}
	if (value instanceof ArrayBuffer) return value.byteLength;
	if (Array.isArray(value)) {
		let size = 2;
		for (const item of value) size += approximateSize(item);
		return size;
	}
	let size = 2;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		size += key.length + approximateSize(item);
	}
	return size;
}
