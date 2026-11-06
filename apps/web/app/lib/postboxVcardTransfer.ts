/**
 * The vCard import and export runs behind `usePostboxVcardTransfer`. Loaded
 * with `import()` when one starts, so the parser, the serializer and these
 * loops stay out of the contacts page's own bundle; the composable keeps the
 * state and the Convex calls, which need a component's setup.
 */
import {
	normalizeVcardPhoto,
	parseVcards,
	serializeVcards,
	type VcardContactEntry,
	type VcardPhoto,
} from '@owlat/shared/postboxVcard';
import {
	VCARD_IMPORT_BATCH_SIZE,
	VCARD_MAX_PHOTO_BYTES,
	VCARD_PHOTO_BATCH_SIZE,
} from '@owlat/shared/postboxVcardLimits';
import {
	vcardExportFilename,
	vcardFileRejection,
	type VcardFileRejection,
} from '~/utils/postboxVcardFile';

export type VcardImportOutcome =
	| { kind: 'rejected'; reason: VcardFileRejection | 'empty' | 'unreadable' }
	| {
			kind: 'done' | 'stopped';
			created: number;
			merged: number;
			skippedWithoutEmail: number;
			isTruncated: boolean;
	  };

type BatchResult = { ok: true; result: { created: number; merged: number } } | { ok: false };
type ImportEntry = Omit<VcardContactEntry, 'photo'>;
export type PhotoUpload = { email: string; base64: string };

/**
 * Parse `file` and write its entries in batches, one after another, so a
 * failed batch stops the import with what was already written kept. The
 * entries' pictures follow each batch through `writePhotos`, a few per call;
 * a picture that does not arrive leaves its row without one.
 */
export async function importVcardFile(
	file: File,
	writeBatch: (entries: ImportEntry[]) => Promise<BatchResult>,
	writePhotos?: (photos: PhotoUpload[]) => Promise<unknown>
): Promise<VcardImportOutcome> {
	const rejection = vcardFileRejection(file);
	if (rejection) return { kind: 'rejected', reason: rejection };
	const parsed = parseVcards(await file.text());
	if (parsed.entries.length === 0) return { kind: 'rejected', reason: 'empty' };
	let created = 0;
	let merged = 0;
	let kind: 'done' | 'stopped' = 'done';
	for (let start = 0; start < parsed.entries.length; start += VCARD_IMPORT_BATCH_SIZE) {
		const batch = parsed.entries.slice(start, start + VCARD_IMPORT_BATCH_SIZE);
		const result = await writeBatch(batch.map(({ photo: _photo, ...entry }) => entry));
		if (!result.ok) {
			kind = 'stopped';
			break;
		}
		created += result.result.created;
		merged += result.result.merged;
		if (writePhotos) await uploadPhotos(batch, writePhotos);
	}
	return {
		kind,
		created,
		merged,
		skippedWithoutEmail: parsed.skippedWithoutEmail,
		isTruncated: parsed.isTruncated,
	};
}

async function uploadPhotos(
	entries: readonly VcardContactEntry[],
	writePhotos: (photos: PhotoUpload[]) => Promise<unknown>
): Promise<void> {
	const photos = entries.flatMap((entry) =>
		entry.photo ? [{ email: entry.email, base64: entry.photo.base64 }] : []
	);
	for (let start = 0; start < photos.length; start += VCARD_PHOTO_BATCH_SIZE) {
		await writePhotos(photos.slice(start, start + VCARD_PHOTO_BATCH_SIZE));
	}
}

interface ExportRow extends Omit<VcardContactEntry, 'photo'> {
	/** A short-lived URL of the row's picture. */
	photoUrl?: string;
}

interface ExportPage {
	page: ExportRow[];
	isDone: boolean;
	continueCursor: string;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** The picture at a storage URL as a card's PHOTO, or null when it cannot be read. */
export async function readPhoto(url: string): Promise<VcardPhoto | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > VCARD_MAX_PHOTO_BYTES) return null;
		return normalizeVcardPhoto(bytesToBase64(bytes));
	} catch {
		return null;
	}
}

/**
 * Read every page of the book and download it as one .vcf file. A row's
 * picture is read from its URL; one that cannot be read leaves the card
 * without a PHOTO rather than failing the export.
 */
export async function exportVcardBook(
	readPage: (cursor: string | null) => Promise<ExportPage>,
	loadPhoto: (url: string) => Promise<VcardPhoto | null> = readPhoto
): Promise<void> {
	const entries: VcardContactEntry[] = [];
	let cursor: string | null = null;
	for (;;) {
		const result = await readPage(cursor);
		for (const { photoUrl, ...row } of result.page) {
			const photo = photoUrl ? await loadPhoto(photoUrl) : null;
			entries.push(photo ? { ...row, photo } : row);
		}
		if (result.isDone) break;
		cursor = result.continueCursor;
	}
	const url = URL.createObjectURL(
		new Blob([serializeVcards(entries)], { type: 'text/vcard;charset=utf-8' })
	);
	const link = document.createElement('a');
	link.href = url;
	link.setAttribute('download', vcardExportFilename(new Date()));
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}
