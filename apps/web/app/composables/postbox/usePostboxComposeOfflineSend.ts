/**
 * The offline send path's payload builder, split out of `usePostboxCompose`.
 *
 * A send fired with no connection (or one whose transport failed mid-flight)
 * never touches the network: the FULL compose payload is queued on-device so
 * the reconnect drain can replay `create → update → send` even for a
 * composition that never had a server draft row. That completeness is the whole
 * contract — a bare `draftId` reference would be unreplayable offline — which
 * is why this is a wide snapshot of every field rather than a diff.
 *
 * Extracted so `usePostboxCompose` stays under the file-size ratchet, the same
 * seam its hydration and attachment halves already use. Behaviour is unchanged:
 * the caller still owns the autosave timer (it cancels it through
 * `cancelAutosave` — there is nothing to flush to a server we cannot reach) and
 * still owns the emit contract.
 */

import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { OfflineComposePayload } from '~/utils/postboxOfflineStore';
import type { ComposerAttachment } from './usePostboxComposeAttachments';
import type { ComposerMode } from './usePostboxCompose';

/** Per-send overrides, passed through to the queued payload verbatim. */
export type SendOpts = {
	undoSendDelayMs?: number;
	scheduledSendAt?: number;
	allowUnsealed?: boolean;
};

export interface OfflineSendSources {
	mailboxId: Id<'mailboxes'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	draftId: Ref<Id<'mailDrafts'> | null>;
	toAddresses: Ref<string[]>;
	ccAddresses: Ref<string[]>;
	bccAddresses: Ref<string[]>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	bodyBlocks: Ref<EditorBlock[]>;
	composerMode: Ref<ComposerMode>;
	fromAddress: Ref<string>;
	followUpRemindAt: Ref<number | null>;
	attachments: Ref<ComposerAttachment[]>;
	/** Drop the pending autosave — its target is unreachable anyway. */
	cancelAutosave: () => void;
	/** Queue the payload and hand back the synthetic `{undoToken, sendAt}`. */
	queue: (
		payload: OfflineComposePayload,
		undoSendDelayMs: number | undefined
	) => Promise<{ undoToken: string; sendAt: number }>;
	/** The user's undo-send window, for the toast the queue arms. */
	undoSendDelayMs: () => number | undefined;
}

/**
 * Build the queue-a-send function. Returns `{undoToken, sendAt}` exactly like a
 * real send, and throws when the device cannot store the payload — the caller
 * must never arm undo on a message that was not actually kept anywhere.
 */
export function usePostboxComposeOfflineSend(sources: OfflineSendSources) {
	return async function queueOfflineSend(
		opts?: SendOpts
	): Promise<{ undoToken: string; sendAt: number }> {
		// Nothing to flush to a server we can't reach — the payload carries the
		// live field values, which supersede whatever autosave last persisted.
		sources.cancelAutosave();
		const payload: OfflineComposePayload = {
			mailboxId: String(sources.mailboxId),
			draftId: sources.draftId.value ? String(sources.draftId.value) : undefined,
			inReplyToMessageId: sources.inReplyToMessageId
				? String(sources.inReplyToMessageId)
				: undefined,
			toAddresses: [...sources.toAddresses.value],
			ccAddresses: [...sources.ccAddresses.value],
			bccAddresses: [...sources.bccAddresses.value],
			subject: sources.subject.value,
			bodyHtml: sources.bodyHtml.value,
			bodyBlocks:
				sources.composerMode.value === 'full'
					? JSON.stringify(sources.bodyBlocks.value)
					: undefined,
			composerMode: sources.composerMode.value,
			fromAddress: sources.fromAddress.value || undefined,
			followUpRemindAt: sources.followUpRemindAt.value,
			attachments: sources.attachments.value.map((a) => ({
				storageId: String(a.storageId),
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			})),
			// The caller's options VERBATIM: the reconnect drain replays these, and
			// it deliberately dispatches a drained item immediately (the sender
			// already had their undo window while it sat in the queue). Baking the
			// undo preference in here would re-arm that hold after reconnect, with
			// no toast left to cancel it — so the window travels beside the payload
			// instead, where only the toast reads it.
			sendOptions: opts,
		};
		return sources.queue(payload, sources.undoSendDelayMs());
	};
}
