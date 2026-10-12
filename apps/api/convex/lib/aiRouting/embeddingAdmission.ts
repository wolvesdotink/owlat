/**
 * The admission seam for paid embedding work (ADR-0073, D8 and Phase 1b).
 *
 * A re-embed or staged rebuild on a hosted embedder costs money, so it starts
 * only from an admin action and every batch is admitted against the spend
 * ceilings first. Admission (reservations, aggregates, settlement) belongs to
 * the admission lane. Until it fills the seam below, paid
 * embedding work is refused outright: the start mutations throw, and a running
 * paid job pauses with reason `budget`. Local embedders never go through here.
 *
 * The admission lane replaces the `null` in `seam` with an implementation;
 * nothing else changes.
 */

import type { ReembedJobKind } from '@owlat/shared/aiRouting';
import type { ActionCtx } from '../../_generated/server';

/** One batch of paid embedding calls, described before any call is made. */
export interface PaidEmbeddingBatch {
	/** The job's root request; every ledger row of the job groups under it. */
	readonly rootRequestId: string;
	readonly task: 'embedding.index';
	/** `reembed` (bring legacy and inactive rows back) or `rebuild` (Phase 5). */
	readonly jobKind: ReembedJobKind | 'probe';
	readonly provider: string;
	readonly model: string;
	/** How many texts the batch embeds, and their total length in characters. */
	readonly items: number;
	readonly inputChars: number;
}

export type PaidEmbeddingAdmissionResult =
	| {
			readonly isAdmitted: true;
			/** Settle the hold with what the batch really used, or release it. */
			readonly settle: (usage: { readonly inputTokens: number | undefined }) => Promise<void>;
	  }
	| { readonly isAdmitted: false; readonly reason: string };

export interface PaidEmbeddingAdmission {
	admitBatch(ctx: ActionCtx, batch: PaidEmbeddingBatch): Promise<PaidEmbeddingAdmissionResult>;
}

/**
 * Filled by the admission lane (replace `null` with its implementation).
 * `null` ⇒ paid embedding work is refused.
 */
const seam: { readonly admission: PaidEmbeddingAdmission | null } = { admission: null };

export function isPaidEmbeddingAdmissionAvailable(): boolean {
	return seam.admission !== null;
}

/** Admit one paid batch, or refuse it (always, while admission is absent). */
export async function admitPaidEmbeddingBatch(
	ctx: ActionCtx,
	batch: PaidEmbeddingBatch
): Promise<PaidEmbeddingAdmissionResult> {
	const admission = seam.admission;
	if (!admission) {
		return {
			isAdmitted: false,
			reason: 'Paid embedding needs spend admission, which this build does not have yet.',
		};
	}
	return admission.admitBatch(ctx, batch);
}
