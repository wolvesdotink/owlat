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
	type MailMessageExportBodyFields,
} from './messageBody';
import type { InboundMessageBody, InboundMessageBodyFields } from './messageBodyInbound';
import { bytesToBase64, utf8Bytes } from './bytes';
import { readSealedBlobBytesForExport, readSealedBlobTextForExport } from './sealedBlob';

type ExportBodyAvailability = 'available' | 'missing' | 'corrupt';

interface ExportBodyContent {
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
	if (row.lastPreview == null) return row;
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

/** The inline columns of a Team Inbox row, opened for the contact export. A
 * part held in storage is absent here; see {@link readStoredInboundPartForContactExport}. */
export async function openInboundBodyPreservingLegacyForContactExport(
	row: InboundMessageBodyFields
): Promise<InboundMessageBody & { excerpt: string | undefined }> {
	const openOptionalPreservingLegacy = async (stored: string | undefined) =>
		stored === undefined ? undefined : openBodyPreservingLegacyForContactExport(stored);
	const [text, html, excerpt] = await Promise.all([
		openOptionalPreservingLegacy(row.textBody ?? undefined),
		openOptionalPreservingLegacy(row.htmlBody ?? undefined),
		openOptionalPreservingLegacy(row.bodyExcerpt ?? undefined),
	]);
	return { text, html, excerpt };
}

/** What became of one stored Team Inbox body part in a contact export. */
export type StoredPartExportAvailability = ExportBodyAvailability | 'omitted';

/**
 * Read one Team Inbox body part held in storage for the contact export, within
 * a byte budget shared by the whole bundle.
 *
 * The bundle is returned from one action, so it has a size ceiling of its own;
 * a contact with a hundred large newsletters cannot all be inlined. A part whose
 * blob would overrun the budget is not read and is reported `omitted` — the
 * row still carries its excerpt — rather than failing the whole export.
 * Missing and corrupt blobs are reported the way the account export reports
 * them, and ciphertext never leaves.
 */
export async function readStoredInboundPartForContactExport(
	storage: BodyBlobStorageReader,
	storageId: Id<'_storage'>,
	storedBytes: number | undefined,
	budget: { remainingBytes: number }
): Promise<{ content: string | undefined; availability: StoredPartExportAvailability }> {
	if (storedBytes === undefined) return { content: undefined, availability: 'missing' };
	// A blob is its text plus a few bytes of envelope, and JSON never shrinks
	// text, so this skips a read the budget could (all but) not take anyway.
	if (storedBytes > budget.remainingBytes) return { content: undefined, availability: 'omitted' };
	const opened = await readSealedBlobTextForExport(storage, storageId);
	if (opened.availability !== 'available') {
		return { content: undefined, availability: opened.availability };
	}
	// Charged as it will be returned: JSON escaping can grow a body.
	const cost = utf8Bytes(JSON.stringify(opened.content)).byteLength;
	if (cost > budget.remainingBytes) return { content: undefined, availability: 'omitted' };
	budget.remainingBytes -= cost;
	return { content: opened.content, availability: 'available' };
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
				contentBase64: opened.availability === 'available' ? bytesToBase64(opened.content) : null,
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
		rawMessage: bytesToBase64(raw.content),
		rawMessageEncoding: 'base64',
		bodyAvailability: {
			text: text.availability,
			html: html.availability,
			raw: raw.availability,
		},
	};
}
