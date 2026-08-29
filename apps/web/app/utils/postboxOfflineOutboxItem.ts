/**
 * Outbox item shape, queued-send payload and claim bookkeeping for the offline
 * send queue (the `outbox:{ns}` key family in postboxOfflineStore.ts). Split
 * into its own module so the store stays under the file-size ratchet; the
 * store re-exports everything here, so import sites are unchanged.
 */

/** An attachment already committed server-side, referenced by storage id. */
export interface OfflineComposeAttachmentRef {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}

/**
 * The FULL compose payload of a queued offline send — everything needed to
 * replay `drafts.create → update → send` on reconnect. Payload-complete by
 * design: a fully-offline composition has no server draft row, so a bare
 * `draftId` reference would be unreplayable. Ids are plain strings (this is a
 * pure data layer; the drain path casts back to Convex ids).
 */
export interface OfflineComposePayload {
	mailboxId: string;
	/** The server draft row, when one existed before the device went offline. */
	draftId?: string;
	inReplyToMessageId?: string;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	/** Serialized EditorBlock[] — present only in 'full' composer mode. */
	bodyBlocks?: string;
	composerMode: 'simple' | 'full';
	fromAddress?: string;
	followUpRemindAt?: number | null;
	/** Refs to already-uploaded attachments; offline-added files cannot queue. */
	attachments: OfflineComposeAttachmentRef[];
	sendOptions?: {
		undoSendDelayMs?: number;
		scheduledSendAt?: number;
		allowUnsealed?: boolean;
	};
}

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
