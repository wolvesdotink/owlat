/**
 * Lenient message-body projections for data-subject exports.
 *
 * The core storage-shape and sealing primitives remain in messageBody.ts. This
 * sibling makes the export boundary policy explicit: malformed authenticated
 * ciphertext is quarantined and its stored representation never leaves Owlat.
 */

import type { Doc, Id } from '../_generated/dataModel';
import { hasAtRestEnvelopePrefix, isSealedAtRest } from './atRestBodies';
import {
	openMessageBody,
	type BodyBlobStorageReader,
	type InboundMessageBody,
	type InboundMessageBodyFields,
	type MailMessageExportBodyFields,
} from './messageBody';
import { accountExportBytesToBase64 } from './accountExportEncoding';
import { readSealedBlobBytesForExport, readSealedBlobTextForExport } from './sealedBlob';

export type ExportBodyAvailability = 'available' | 'missing' | 'corrupt';

export interface ExportBodyContent {
	content: string;
	availability: Exclude<ExportBodyAvailability, 'missing'>;
}

/** Account-export policy: malformed ciphertext becomes blank/corrupt and its
 * encrypted storage representation never crosses the account boundary. */
export async function openAccountExportBodyContent(stored: string): Promise<ExportBodyContent> {
	if (hasAtRestEnvelopePrefix(stored) && !isSealedAtRest(stored)) {
		return { content: '', availability: 'corrupt' };
	}
	try {
		return { content: await openMessageBody(stored), availability: 'available' };
	} catch {
		return { content: '', availability: 'corrupt' };
	}
}

/** Contact-export compatibility policy. `openMessageBody` already returns
 * ordinary legacy plaintext unchanged. A failure therefore means an
 * authenticated sealed envelope could not be opened; never expose it. */
export async function openBodyPreservingLegacyForContactExport(stored: string): Promise<string> {
	if (hasAtRestEnvelopePrefix(stored) && !isSealedAtRest(stored)) return '';
	try {
		return await openMessageBody(stored);
	} catch {
		return '';
	}
}

export async function openConversationPreviewPreservingLegacyForContactExport<
	T extends { lastPreview?: string | null },
>(row: T): Promise<T> {
	if (row.lastPreview === undefined || row.lastPreview === null) return row;
	return {
		...row,
		lastPreview: await openBodyPreservingLegacyForContactExport(row.lastPreview),
	};
}

async function openOptionalAccountExportBody(stored: string | undefined): Promise<{
	content: string | undefined;
	availability: ExportBodyAvailability;
}> {
	if (stored === undefined) return { content: undefined, availability: 'missing' };
	return openAccountExportBodyContent(stored);
}

export async function openInboundBodyPreservingLegacyForContactExport(
	row: InboundMessageBodyFields
): Promise<InboundMessageBody> {
	const openOptionalPreservingLegacy = async (stored: string | undefined) =>
		stored === undefined ? undefined : openBodyPreservingLegacyForContactExport(stored);
	const [text, html] = await Promise.all([
		openOptionalPreservingLegacy(row.textBody ?? undefined),
		openOptionalPreservingLegacy(row.htmlBody ?? undefined),
	]);
	return { text, html };
}

export async function openMailDraftForAccountExport(
	storage: BodyBlobStorageReader,
	draft: Doc<'mailDrafts'>
): Promise<
	Omit<Doc<'mailDrafts'>, 'attachments'> & {
		attachments: Array<
			Omit<Doc<'mailDrafts'>['attachments'][number], 'storageId'> & {
				contentBase64: string | null;
				isContentAvailable: boolean;
				contentAvailability: ExportBodyAvailability;
			}
		>;
		bodyAvailability: {
			html: ExportBodyAvailability;
			text: ExportBodyAvailability;
			blocks: ExportBodyAvailability;
		};
	}
> {
	const attachments = await Promise.all(
		draft.attachments.map(async ({ storageId, ...attachment }) => {
			const opened = await readSealedBlobBytesForExport(storage, storageId);
			return {
				...attachment,
				contentBase64:
					opened.availability === 'available' ? accountExportBytesToBase64(opened.content) : null,
				isContentAvailable: opened.availability === 'available',
				contentAvailability: opened.availability,
			};
		})
	);
	const [bodyHtml, bodyText, bodyBlocks] = await Promise.all([
		openAccountExportBodyContent(draft.bodyHtml),
		openOptionalAccountExportBody(draft.bodyText),
		openOptionalAccountExportBody(draft.bodyBlocks),
	]);
	return {
		...draft,
		bodyHtml: bodyHtml.content,
		bodyText: bodyText.content,
		bodyBlocks: bodyBlocks.content,
		attachments,
		bodyAvailability: {
			html: bodyHtml.availability,
			text: bodyText.availability,
			blocks: bodyBlocks.availability,
		},
	};
}

export async function readMailMessageBodiesForAccountExport(
	storage: BodyBlobStorageReader,
	row: MailMessageExportBodyFields
): Promise<{
	textBody: string;
	htmlBody: string;
	rawMessage: string;
	rawMessageEncoding: 'base64';
	bodyAvailability: {
		text: ExportBodyAvailability;
		html: ExportBodyAvailability;
		raw: ExportBodyAvailability;
	};
}> {
	const readBlob = async (
		storageId: Id<'_storage'> | undefined
	): Promise<{ content: string; availability: ExportBodyAvailability }> => {
		if (!storageId) return { content: '', availability: 'missing' };
		return readSealedBlobTextForExport(storage, storageId);
	};
	const text =
		row.textBodyInline !== undefined
			? await openAccountExportBodyContent(row.textBodyInline)
			: await readBlob(row.textBodyStorageId);
	const html =
		row.htmlBodyInline !== undefined
			? await openAccountExportBodyContent(row.htmlBodyInline)
			: await readBlob(row.htmlBodyStorageId);
	const raw =
		row.rawStorageId === undefined
			? { content: new Uint8Array(), availability: 'missing' as const }
			: await readSealedBlobBytesForExport(storage, row.rawStorageId);
	return {
		textBody: text.content,
		htmlBody: html.content,
		rawMessage: accountExportBytesToBase64(raw.content),
		rawMessageEncoding: 'base64',
		bodyAvailability: {
			text: text.availability,
			html: html.availability,
			raw: raw.availability,
		},
	};
}
