/**
 * Lenient message-body projections for data-subject exports.
 *
 * The core storage-shape and sealing primitives remain in messageBody.ts. This
 * sibling makes two boundary policies explicit: account exports quarantine
 * malformed ciphertext as blank/corrupt, while the older contact export
 * preserves envelope-shaped legacy plaintext for mixed-state compatibility.
 */

import type { Doc, Id } from '../_generated/dataModel';
import {
	openMessageBody,
	type BodyBlobStorageReader,
	type InboundMessageBody,
	type InboundMessageBodyFields,
	type MailMessageExportBodyFields,
} from './messageBody';
import { readSealedBlobTextForExport } from './sealedBlob';

export type ExportBodyAvailability = 'available' | 'missing' | 'corrupt';

export interface ExportBodyContent {
	content: string;
	availability: Exclude<ExportBodyAvailability, 'missing'>;
}

/** Account-export policy: malformed ciphertext becomes blank/corrupt and its
 * encrypted storage representation never crosses the account boundary. */
export async function openAccountExportBodyContent(stored: string): Promise<ExportBodyContent> {
	try {
		return { content: await openMessageBody(stored), availability: 'available' };
	} catch {
		return { content: '', availability: 'corrupt' };
	}
}

/** Contact-export compatibility policy: preserve an undecryptable stored value
 * because it may be legacy plaintext that merely resembles a sealed envelope. */
export async function openBodyPreservingLegacyForContactExport(stored: string): Promise<string> {
	try {
		return await openMessageBody(stored);
	} catch {
		return stored;
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

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
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
			const blob = await storage.get(storageId);
			return {
				...attachment,
				contentBase64: blob ? bytesToBase64(new Uint8Array(await blob.arrayBuffer())) : null,
				isContentAvailable: blob !== null,
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
	const text = row.textBodyInline
		? await openAccountExportBodyContent(row.textBodyInline)
		: await readBlob(row.textBodyStorageId);
	const html = row.htmlBodyInline
		? await openAccountExportBodyContent(row.htmlBodyInline)
		: await readBlob(row.htmlBodyStorageId);
	const raw = await readBlob(row.rawStorageId);
	return {
		textBody: text.content,
		htmlBody: html.content,
		rawMessage: raw.content,
		bodyAvailability: {
			text: text.availability,
			html: html.availability,
			raw: raw.availability,
		},
	};
}
