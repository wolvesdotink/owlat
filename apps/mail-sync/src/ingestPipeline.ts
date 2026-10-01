/**
 * Stage several messages at once, commit them one at a time in arrival order.
 *
 * Ingesting a message is two round trips: the raw `.eml` upload and the
 * `ingestExternalRaw` call. Done strictly one message after the other, a
 * folder with a few hundred new messages spends most of its time waiting on
 * the network. Only the commit has to stay ordered — it advances the folder
 * cursor and dedupes on Message-ID — so the uploads of the next few messages
 * run while the current one commits.
 *
 * The stage of item N+k starts once item N is committed or given up on, so at
 * most `concurrency` staged messages are ever held. A stage failure is not
 * thrown here: it is handed to `commit` in its turn, in order, so the caller
 * records the failure at the same place in the sequence it would have
 * recorded it without the pipeline.
 *
 * A staged item that is never committed (the pipeline stopped, or a commit
 * ahead of it threw) is handed to `discard`, so what its stage holds — the
 * uploaded raw blob — does not outlive it.
 */

export type StageResult<S> = { ok: true; value: S } | { ok: false; error: unknown };

export interface IngestPipelineOptions<T, S> {
	/** How many items may be staged ahead of the one being committed. */
	concurrency: number;
	/** The parallel half (parse + upload). Its rejection is caught. */
	stage(item: T): Promise<S>;
	/**
	 * The ordered half. Runs once per item, in arrival order, never two at a
	 * time. A throw aborts the pipeline: the items not yet committed are left
	 * uncommitted, and the error propagates.
	 */
	commit(item: T, staged: StageResult<S>): Promise<void>;
	/** Checked before each commit; a stopped pipeline commits nothing more. */
	isStopped(): boolean;
	/**
	 * Release a successful stage that will never be committed. Not called for
	 * an item whose commit ran (and possibly threw): the server may already
	 * hold it. A rejection is ignored; the item is left as it was.
	 */
	discard?(item: T, staged: S): Promise<void>;
}

/**
 * Run `items` through the pipeline. Resolves with the items committed, in
 * order — a prefix of the input, which is what makes "the highest committed
 * UID" a safe cursor.
 */
export async function runIngestPipeline<T, S>(
	items: AsyncIterable<T> | Iterable<T>,
	options: IngestPipelineOptions<T, S>
): Promise<T[]> {
	const width = Math.max(1, Math.floor(options.concurrency));
	const inFlight: Array<{ item: T; result: Promise<StageResult<S>> }> = [];
	const committed: T[] = [];
	let stopped = false;
	let commitFailed = false;

	const discard = async (entry: { item: T; result: Promise<StageResult<S>> }): Promise<void> => {
		const result = await entry.result;
		if (!result.ok || !options.discard) return;
		try {
			await options.discard(entry.item, result.value);
		} catch {
			// Left as it was: a discard is housekeeping, never a reason to fail.
		}
	};

	const commitHead = async (): Promise<void> => {
		const head = inFlight.shift();
		if (!head) return;
		const result = await head.result;
		if (options.isStopped()) {
			stopped = true;
			await discard(head);
			return;
		}
		try {
			await options.commit(head.item, result);
		} catch (error) {
			commitFailed = true;
			throw error;
		}
		committed.push(head.item);
	};

	try {
		let sourceError: { error: unknown } | null = null;
		try {
			for await (const item of items) {
				if (stopped || options.isStopped()) {
					stopped = true;
					break;
				}
				inFlight.push({
					item,
					result: options.stage(item).then(
						(value): StageResult<S> => ({ ok: true, value }),
						(error: unknown): StageResult<S> => ({ ok: false, error })
					),
				});
				if (inFlight.length >= width) await commitHead();
			}
		} catch (error) {
			if (commitFailed) throw error;
			// The source broke (an IMAP stream dropped mid-fetch). What it already
			// yielded is still committed below, as a one-at-a-time loop would have
			// done before reaching the break, and then the error is rethrown.
			sourceError = { error };
		}
		while (inFlight.length > 0) {
			await commitHead();
			if (stopped) break;
		}
		if (sourceError) throw sourceError.error;
	} finally {
		// Stages still running after a stop or a throw: let them settle so no
		// upload outlives the caller's lock, then release what they staged.
		await Promise.all(inFlight.map(discard));
	}
	return committed;
}

/**
 * Raw uploads in flight at once while a folder's new mail is ingested. The
 * ingest calls themselves still commit one at a time, in UID order.
 */
export const FORWARD_INGEST_CONCURRENCY = 4;

/** A fetched message that carries a body, with the fields ingest reads. */
export interface FetchedSource {
	uid: number;
	source: Buffer;
	flags: Set<string>;
}

/**
 * The messages of a `lastSeenUid+1:*` fetch that are actually new. `n:*`
 * always returns the highest UID even when it is below `n` (RFC 3501 §6.4.8),
 * and a message without a body has nothing to ingest.
 */
export async function* newMessages(
	fetched: AsyncIterable<{ uid: number | string; source?: Buffer; flags?: Set<string> }>,
	lastSeenUid: number
): AsyncGenerator<FetchedSource> {
	for await (const msg of fetched) {
		const uid = Number(msg.uid);
		if (!msg.source || uid <= lastSeenUid) continue;
		yield { uid, source: msg.source, flags: msg.flags ?? new Set<string>() };
	}
}
