/**
 * The vCard import and export runs behind `usePostboxVcardTransfer`. Loaded
 * with `import()` when one starts, so the parser, the serializer and these
 * loops stay out of the contacts page's own bundle; the composable keeps the
 * state and the Convex calls, which need a component's setup.
 */
import { parseVcards, serializeVcards, type VcardContactEntry } from '@owlat/shared/postboxVcard';
import { VCARD_IMPORT_BATCH_SIZE } from '@owlat/shared/postboxVcardLimits';
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

/**
 * Parse `file` and write its entries in batches, one after another, so a
 * failed batch stops the import with what was already written kept.
 */
export async function importVcardFile(
	file: File,
	writeBatch: (entries: VcardContactEntry[]) => Promise<BatchResult>
): Promise<VcardImportOutcome> {
	const rejection = vcardFileRejection(file);
	if (rejection) return { kind: 'rejected', reason: rejection };
	const parsed = parseVcards(await file.text());
	if (parsed.entries.length === 0) return { kind: 'rejected', reason: 'empty' };
	let created = 0;
	let merged = 0;
	let kind: 'done' | 'stopped' = 'done';
	for (let start = 0; start < parsed.entries.length; start += VCARD_IMPORT_BATCH_SIZE) {
		const result = await writeBatch(parsed.entries.slice(start, start + VCARD_IMPORT_BATCH_SIZE));
		if (!result.ok) {
			kind = 'stopped';
			break;
		}
		created += result.result.created;
		merged += result.result.merged;
	}
	return {
		kind,
		created,
		merged,
		skippedWithoutEmail: parsed.skippedWithoutEmail,
		isTruncated: parsed.isTruncated,
	};
}

interface ExportPage {
	page: VcardContactEntry[];
	isDone: boolean;
	continueCursor: string;
}

/** Read every page of the book and download it as one .vcf file. */
export async function exportVcardBook(
	readPage: (cursor: string | null) => Promise<ExportPage>
): Promise<void> {
	const entries: VcardContactEntry[] = [];
	let cursor: string | null = null;
	for (;;) {
		const result = await readPage(cursor);
		entries.push(...result.page);
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
