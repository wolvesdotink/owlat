/**
 * Byte budget for the SMTP DATA phase.
 *
 * This PORTS `apps/mta/src/lib/dataStream.ts` semantics EXACTLY (D5 — the byte
 * budget is load-bearing):
 *
 *  - Within budget: buffer the chunk.
 *  - Once the streamed total crosses `maxBytes`: stop buffering (memory stays
 *    bounded at `maxBytes`) and release what was buffered, but keep draining so
 *    the SMTP dialogue can still answer with a clean 552.
 *  - Once the streamed total crosses `maxBytes * abortFactor`: destroy the
 *    stream outright to also bound bandwidth.
 *
 * `smtp-server`'s `size` option only *advertises* EHLO SIZE and validates the
 * client's declared `MAIL FROM ... SIZE=` — it does NOT enforce the number of
 * bytes actually streamed. A client that omits/lies about SIZE can stream
 * gigabytes; pre-auth that is a trivial remote memory-exhaustion DoS against the
 * public MX. The budget bounds it. The listener command loop feeds DATA bytes
 * through {@link ByteBudget} chunk-by-chunk; the standalone
 * {@link collectDataStream} preserves the exact `Readable` entry point the old
 * code exposed (kept for parity and reuse).
 */

import type { Readable } from 'node:stream';

/** Per-push verdict from {@link ByteBudget}. */
export type BudgetVerdict = 'ok' | 'over' | 'abort';

/**
 * Streaming byte accumulator with the drain-past-limit / destroy-at-4x policy.
 * Both the command loop's DATA reader and {@link collectDataStream} route
 * through this so the semantics are defined in exactly one place.
 */
export class ByteBudget {
	private readonly chunks: Buffer[] = [];
	private totalBytes = 0;
	private exceeded = false;

	constructor(
		private readonly maxBytes: number,
		private readonly abortFactor = 4
	) {}

	/**
	 * Offer a chunk to the budget.
	 *  - `ok`    — buffered, still within budget.
	 *  - `over`  — budget crossed; the chunk (and all prior buffered chunks) are
	 *              discarded but the caller should keep draining.
	 *  - `abort` — the `abortFactor` ceiling was crossed; the caller must destroy
	 *              the stream now.
	 */
	push(chunk: Buffer): BudgetVerdict {
		this.totalBytes += chunk.length;
		if (!this.exceeded && this.totalBytes <= this.maxBytes) {
			this.chunks.push(chunk);
			return 'ok';
		}
		if (!this.exceeded) {
			this.exceeded = true;
			this.chunks.length = 0; // release what we buffered so far
		}
		if (this.totalBytes > this.maxBytes * this.abortFactor) {
			return 'abort';
		}
		return 'over';
	}

	/** Whether the budget was ever crossed. */
	get isExceeded(): boolean {
		return this.exceeded;
	}

	/** Total bytes offered so far (including discarded ones). */
	get total(): number {
		return this.totalBytes;
	}

	/** The buffered message. Only meaningful when {@link isExceeded} is false. */
	result(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

/**
 * Collect an SMTP DATA stream into a Buffer with a hard byte budget. Exact port
 * of `apps/mta/src/lib/dataStream.ts::collectDataStream`, re-expressed on top of
 * {@link ByteBudget} so the standalone `Readable` path and the command loop's
 * chunk path share one policy.
 */
export async function collectDataStream(
	stream: Readable & { sizeExceeded?: boolean },
	maxBytes: number,
	abortFactor = 4
): Promise<{ ok: true; buffer: Buffer } | { ok: false }> {
	const budget = new ByteBudget(maxBytes, abortFactor);
	for await (const chunk of stream) {
		const verdict = budget.push(chunk as Buffer);
		if (verdict === 'abort') {
			stream.destroy();
			return { ok: false };
		}
	}
	// smtp-server flags declared-size violations itself; honor that too.
	if (budget.isExceeded || stream.sizeExceeded) {
		return { ok: false };
	}
	return { ok: true, buffer: budget.result() };
}

/** SMTP 552: requested mail action aborted, exceeded storage allocation. */
export function messageTooLargeError(maxBytes: number): Error & { responseCode: number } {
	const err = new Error(
		`Message exceeds maximum size of ${Math.floor(maxBytes / (1024 * 1024))}MB`
	) as Error & { responseCode: number };
	err.responseCode = 552;
	return err;
}
