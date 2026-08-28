/**
 * Outbox item shape + claim bookkeeping for the offline send queue (the
 * `outbox:{ns}` key family in postboxOfflineStore.ts). Split into its own
 * module so the store stays under the file-size ratchet; the store re-exports
 * everything here, so import sites are unchanged.
 */

import type { OfflineComposePayload } from './postboxOfflineStore';

/** One queued send in the `outbox:{ns}` key family. */
export interface OfflineOutboxItem {
	id: string;
	payload: OfflineComposePayload;
	queuedAt: number;
	attempts: number;
	lastError?: string;
	/**
	 * When the drain took ownership of this item for a send attempt (see
	 * {@link PostboxOfflineStore.claimOutbox}). While the claim is live the item
	 * is on its way to the wire and must not be un-queued;
	 * {@link PostboxOfflineStore.markOutboxAttempt} clears it again on failure.
	 */
	claimedAt?: number;
}

/**
 * How long a claim stamp is honoured. A tab killed mid-send would otherwise
 * leave its item claimed forever — undrainable AND un-undoable — so an old
 * stamp expires. Comfortably longer than a create → update → send round trip.
 */
export const OUTBOX_CLAIM_TTL_MS = 60_000;

/** True while `item` is claimed by a send attempt that has not yet expired. */
export function isOutboxClaimLive(item: OfflineOutboxItem, now: number = Date.now()): boolean {
	return item.claimedAt !== undefined && now - item.claimedAt < OUTBOX_CLAIM_TTL_MS;
}
