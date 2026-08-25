/**
 * Dedupe at capture (plan §7.3, replay row).
 *
 * A DKIM signature is replayable by design: a spammer can take one message an
 * innocent domain really signed and inject the identical bytes into thousands
 * of mailboxes, then have each recipient "report" it. Within one observer that
 * is defeated cheaply — the same (`Message-ID`, `bh=`) pair is the same
 * message, and only its first capture becomes evidence.
 *
 * Cross-observer duplicates are NOT detectable here and the plan says so
 * plainly: commitments hide their contents by design, so duplicates surface only
 * at challenge openings, and what bounds an unchallenged replay campaign is
 * per-observer caps plus diversity weighting at scoring time.
 *
 * The retention window is the store's business, not this function's: the pair is
 * "seen" for as long as the store remembers it, which the app sizes to the
 * evidence-bundle retention period (~90 days, §7.2) so a report cannot be
 * re-admitted once its bundle is gone.
 */
import { compareRfc3339, isRfc3339, sha256 } from '@owlat/ostr-core';

/**
 * The observer's memory of what it has already captured. Keys are opaque
 * digests, never Message-IDs, so a persisted dedupe table is not a searchable
 * index of a user's mail.
 *
 * Synchronous on purpose: this sits on the report hot path, and the working set
 * for a retention window is small enough to hold in memory and rehydrate at
 * startup. An app whose durable store is async keeps the in-memory view here and
 * writes through in `add`.
 */
export interface ReportDedupeStore {
	has(key: string): boolean;
	/** Record `key` as captured at `capturedAt` (RFC 3339), for retention. */
	add(key: string, capturedAt: string): void;
}

export interface ReportIdentity {
	/** The message's `Message-ID`, value only. Case is preserved: the local part
	 *  of a Message-ID is case-sensitive, and folding it would merge two
	 *  genuinely distinct messages. */
	messageId: string;
	/** The signature's `bh=`, verbatim. */
	bodyHash: string;
	/**
	 * Opaque, per-observer-stable token for the mailbox that reported it — a
	 * salted hash, exactly like `MessageObservation.recipients`, never an
	 * address.
	 *
	 * DELIBERATELY NOT PART OF THE DEDUPE KEY: two users reporting one replayed
	 * message are still one message, and the second capture must be refused. The
	 * token exists so the batch builder can count DISTINCT REPORTERS, which is
	 * the half of the §7.4 k-floor a report count cannot express — three reports
	 * from one mailbox tell the accused which of its recipients complained.
	 */
	reporter?: string;
}

export type ReportCaptureDecision =
	| {
			capture: true;
			key: string;
			/** Echoed back so the caller can pair it with the bundle hash when it
			 *  builds the batch, without re-deriving the token. */
			reporter?: string;
	  }
	| { capture: false; key: string | null; reason: 'duplicate' | 'incomplete' };

/**
 * The dedupe key: SHA-256 over the two fields with a NUL separator, so the pair
 * cannot be forged by moving bytes across the boundary, and so the stored key
 * reveals neither field.
 */
export function reportDedupeKey(identity: ReportIdentity): string | null {
	const messageId = typeof identity.messageId === 'string' ? identity.messageId.trim() : '';
	const bodyHash = typeof identity.bodyHash === 'string' ? identity.bodyHash.trim() : '';
	if (messageId === '' || bodyHash === '') return null;
	return sha256(`${messageId}\0${bodyHash}`).toString('hex');
}

/**
 * Decide whether a reported message is a new capture, recording it if so.
 *
 * `capturedAt` (RFC 3339) is passed to the store for retention accounting; this
 * function never reads a clock.
 */
export function shouldCaptureReport(
	identity: ReportIdentity,
	seen: ReportDedupeStore,
	capturedAt: string
): ReportCaptureDecision {
	const key = reportDedupeKey(identity);
	if (key === null) return { capture: false, key: null, reason: 'incomplete' };
	if (seen.has(key)) return { capture: false, key, reason: 'duplicate' };
	seen.add(key, capturedAt);
	const reporter = identity.reporter;
	return typeof reporter === 'string' && reporter !== ''
		? { capture: true, key, reporter }
		: { capture: true, key };
}

/**
 * An in-memory {@link ReportDedupeStore} with explicit retention pruning — the
 * default an app can use directly, and what the tests run against.
 *
 * `prune` takes the cutoff instead of computing it: no clock lives in this
 * package. The caller passes `now - retention` and everything captured before it
 * is forgotten, which is exactly when its evidence bundle is deleted too.
 */
export class MemoryReportDedupeStore implements ReportDedupeStore {
	readonly #captured = new Map<string, string>();

	has(key: string): boolean {
		return this.#captured.has(key);
	}

	add(key: string, capturedAt: string): void {
		this.#captured.set(key, capturedAt);
	}

	/**
	 * Forget everything captured strictly before `cutoff` (RFC 3339). An entry
	 * whose timestamp will not parse is forgotten too: it cannot be shown to be
	 * inside the retention window, and keeping it would pin an untracked key
	 * forever.
	 */
	prune(cutoff: string): number {
		let removed = 0;
		for (const [key, capturedAt] of this.#captured) {
			if (!isRfc3339(capturedAt) || compareRfc3339(capturedAt, cutoff) < 0) {
				this.#captured.delete(key);
				removed++;
			}
		}
		return removed;
	}

	get size(): number {
		return this.#captured.size;
	}
}
