/**
 * Dispatching embedding work under admission (ADR-0073, D8; Sol r2 F12, F15).
 *
 * The one wrapper every embed-lane dispatch goes through: it classifies the
 * embedder about to be called (the ledger's locality rule, from the same
 * configuration read that built it), admits a paid run first, and settles the
 * admitted hold exactly once, in `finally`, with the calls actually started.
 */

import type { ActionCtx } from '../../_generated/server';
import type { IndexEmbedder } from '../llmProvider';
import { admitPaidEmbeddingBatch, type PaidEmbeddingBatch } from './embeddingAdmission';

/** Counts the embedding calls a batch started (`embedTextsForIndex` raises it). */
export interface DispatchCounter {
	dispatched: number;
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
	const counter: DispatchCounter = { dispatched: 0 };
	const isPaid = options.isPaid === true || !embedder.target.isLocal;
	if (!isPaid) return { isAdmitted: true, value: await run(counter) };
	const admission = await admitPaidEmbeddingBatch(ctx, {
		...batch,
		provider: embedder.target.provider,
		model: embedder.target.model,
	});
	if (!admission.isAdmitted) return admission;
	try {
		return { isAdmitted: true, value: await run(counter) };
	} finally {
		await admission.settle({ dispatchedCalls: counter.dispatched, inputTokens: undefined });
	}
}
