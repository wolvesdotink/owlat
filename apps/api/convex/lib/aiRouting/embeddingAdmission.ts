/**
 * The admission seam for paid embedding work (ADR-0073, D8 and Phase 1b).
 *
 * A re-embed or staged rebuild on a hosted embedder costs money, so it starts
 * only from an admin action and every batch is admitted against the spend
 * ceilings first. Admission (reservations, aggregates, settlement) belongs to
 * the admission lane, which fills the seam below with
 * `analytics/embeddingBatchAdmission.ts` `admitEmbeddingBatch`: one hold per
 * batch, every text and attempt at the model's embedding price, settled
 * against the batch's ledger rows. A refusal (the ceiling, the embedding
 * plane's share, an unverifiable spend state) pauses a running paid job with
 * reason `budget`. Local embedders never go through here.
 */

import type { ReembedJobKind } from '@owlat/shared/aiRouting';
import type { ActionCtx } from '../../_generated/server';
import { admitEmbeddingBatch } from '../../analytics/embeddingBatchAdmission';

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
			/**
			 * The hold's id. Every call of the batch is metered by the ledger
			 * (`meterLlmCall`) with this `reservationId` on its row, so the
			 * settlement reads the batch's real spend from the ledger
			 * (`by_reservation_id`).
			 */
			readonly reservationId?: string;
			/**
			 * Settle the hold, exactly once, after the batch. It must NOT write a
			 * ledger row: the meter already wrote one per request. `dispatchedCalls`
			 * counts every call that was started; `providerRequests` counts the
			 * provider requests they made, retries included, which is the number of
			 * rows the settlement waits for. Zero requests releases the hold.
			 */
			readonly settle: (usage: {
				readonly dispatchedCalls: number;
				/** Provider requests the calls made, retries included: one ledger row each. */
				readonly providerRequests: number;
				readonly inputTokens: number | undefined;
			}) => Promise<void>;
	  }
	| { readonly isAdmitted: false; readonly reason: string };

export interface PaidEmbeddingAdmission {
	admitBatch(ctx: ActionCtx, batch: PaidEmbeddingBatch): Promise<PaidEmbeddingAdmissionResult>;
}

/**
 * The implementation (ADR-0073). `null` would refuse all paid embedding work,
 * which is how the embed lane shipped before admission existed.
 */
const seam: { readonly admission: PaidEmbeddingAdmission | null } = {
	// Spend admission (ADR-0073, Phase 1b): one hold per batch, settled against its rows.
	admission: { admitBatch: admitEmbeddingBatch },
};

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
