'use node';

/**
 * Convex adapter over the pure `@owlat/mail-message` composer.
 *
 * The RFC 5322 / RFC 2045 construction now lives in the workspace package
 * `@owlat/mail-message` (pure, zero runtime deps beyond `node:crypto`). This
 * module keeps the Convex-facing surface unchanged: it maps the send path's
 * `DraftRow` onto the package's neutral `ComposeInput` and re-exports the pure
 * helpers, so no Convex call site changes when the composer moves.
 *
 * The orchestration that calls these — scanning, storage, lifecycle, transport
 * — lives in `outbound.ts`.
 */

import { buildRfc822 as buildRfc822Message, type ComposeInput } from '@owlat/mail-message';
import type { Id } from '../_generated/dataModel';

export {
	escapeHeader,
	encodeHeaderValue,
	encodeAddressHeader,
	safeAttachmentFilename,
	randomBoundary,
	quotedPrintableEncode,
	encodeTextBody,
	buildMessageId,
	stripHtml,
} from '@owlat/mail-message';

/**
 * The subset of a draft row the RFC822 builder reads. `outbound.ts` fetches
 * the full row via the lifecycle query and passes it straight through.
 */
export interface DraftRow {
	_id: Id<'mailDrafts'>;
	mailboxId: Id<'mailboxes'>;
	// Send-as choice: the mailbox the reply is sent FROM (a teammate's personal
	// mailbox) when it differs from the thread's `mailboxId`. Unset ⇒ the team/own
	// identity — the classic path. Drives transport + Sent-copy routing.
	sendAsMailboxId?: Id<'mailboxes'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	threadId?: Id<'mailThreads'>;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	fromAddress: string;
	subject: string;
	bodyHtml: string;
	bodyText?: string;
	/**
	 * Rendered AMP4Email body. Present only for block-designed drafts that use
	 * an interactive block (accordion/carousel). When set, the multipart message
	 * carries it as a `text/x-amp-html` alternative for AMP-capable clients,
	 * with the HTML part as the fallback. Not stored on the draft row itself —
	 * `outbound.ts` renders it at dispatch time and mutates it onto the row.
	 */
	bodyAmp?: string;
	bodyBlocks?: string;
	composerMode?: 'simple' | 'full';
	attachments: Array<{
		storageId: Id<'_storage'>;
		filename: string;
		contentType: string;
		size: number;
		isInline: boolean;
		contentId?: string;
	}>;
	state: 'draft' | 'pending_send' | 'scheduled';
	isUnsealedSendAllowed?: boolean;
	undoToken?: string;
	scheduledSendAt?: number;
}

/** Map the Convex `DraftRow` onto the neutral `ComposeInput` the package reads. */
function toComposeInput(draft: DraftRow): ComposeInput {
	return {
		fromAddress: draft.fromAddress,
		toAddresses: draft.toAddresses,
		ccAddresses: draft.ccAddresses,
		bccAddresses: draft.bccAddresses,
		subject: draft.subject,
		bodyHtml: draft.bodyHtml,
		bodyText: draft.bodyText,
		bodyAmp: draft.bodyAmp,
	};
}

export function buildRfc822(
	draft: DraftRow,
	attachmentBuffers: Array<{
		filename: string;
		contentType: string;
		isInline: boolean;
		data: Buffer;
		contentId?: string;
	}>,
	rfc822MessageId: string,
	inReplyToHeaderValue: string | undefined,
	referencesHeaderValue: string | undefined
): { raw: Buffer; size: number } {
	return buildRfc822Message(
		toComposeInput(draft),
		attachmentBuffers,
		rfc822MessageId,
		inReplyToHeaderValue,
		referencesHeaderValue
	);
}
