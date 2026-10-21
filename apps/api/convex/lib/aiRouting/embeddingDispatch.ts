/**
 * Dispatching embedding work under admission.
 *
 * The one wrapper every embed-lane dispatch goes through: it classifies the
 * embedder about to be called (the ledger's locality rule, from the same
 * configuration read that built it), admits a paid run first, and settles the
 * admitted hold exactly once, in `finally`, with the calls actually started.
 */

import type { ActionCtx } from '../../_generated/server';
import type { IndexEmbedder } from '../llmProvider';
import { admitPaidEmbeddingBatch, type PaidEmbeddingBatch } from './embeddingAdmission';

/**
 * Counts the embedding calls a batch started and the provider requests they
 * made (`embedTextsForIndex` raises both), and carries the admission hold the batch runs under, so every metered ledger
 * row names it (`reservationId`).
 */
export interface DispatchCounter {
	dispatched: number;
	/**
	 * Provider requests the calls made (each call's retries included): what the
	 * batch's ledger rows number, so its settlement waits for all of them.
	 */
	providerRequests: number;
	reservationId?: string;
}

/**
 * Run embedding work with `embedder`, admitted when it is paid. The embedder is
 * the one about to be called, so its locality (the ledger's rule, resolved from
 * the same configuration read that built it) decides, never an earlier read. A
 * paid run is admitted first and settled exactly once, in `finally`, with the
 * calls `run` started, so an error mid-batch still settles what it spent.
 */
export async function runAdmittedEmbedding<T>(
	ctx: ActionCtx,
	embedder: IndexEmbedder,
	batch: Omit<PaidEmbeddingBatch, 'provider' | 'model'>,
	run: (counter: DispatchCounter) => Promise<T>,
	/** `isPaid: true` admits even a local embedder (a job whose target is paid). */
	options: { isPaid?: boolean } = {}
): Promise<{ isAdmitted: true; value: T } | { isAdmitted: false; reason: string }> {
	const counter: DispatchCounter = { dispatched: 0, providerRequests: 0 };
	const isPaid = options.isPaid === true || !embedder.target.isLocal;
	if (!isPaid) return { isAdmitted: true, value: await run(counter) };
	const admission = await admitPaidEmbeddingBatch(ctx, {
		...batch,
		provider: embedder.target.provider,
		model: embedder.target.model,
	});
	if (!admission.isAdmitted) return admission;
	if (admission.reservationId) counter.reservationId = admission.reservationId;
	try {
		return { isAdmitted: true, value: await run(counter) };
	} finally {
		await admission.settle({
			dispatchedCalls: counter.dispatched,
			providerRequests: counter.providerRequests,
			inputTokens: undefined,
		});
	}
}
