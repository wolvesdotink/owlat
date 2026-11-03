/**
 * vCard import into and export out of the Postbox address book (the personal
 * `mailContacts`, not the audience contacts and their CSV import).
 *
 * The file is parsed here and written in batches of
 * `VCARD_IMPORT_BATCH_SIZE`; the server bounds every entry again. Batches run
 * one after another, so a failure stops the import with what was already
 * written kept, and the summary says how far it got.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	VCARD_IMPORT_BATCH_SIZE,
	parseVcards,
	serializeVcards,
	type VcardContactEntry,
} from '@owlat/shared/postboxVcard';
import {
	vcardEntryOfContact,
	vcardExportFilename,
	vcardFileRejection,
	type VcardFileRejection,
} from '~/utils/postboxVcardFile';

export type VcardImportOutcome =
	| { kind: 'rejected'; reason: VcardFileRejection | 'empty' }
	| {
			kind: 'done' | 'stopped';
			created: number;
			merged: number;
			skippedWithoutEmail: number;
			isTruncated: boolean;
	  };

export function usePostboxVcardTransfer(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const importOp = useBackendOperation(api.mail.contactsImport.importBatch, {
		label: () => t('shared.postbox.usePostboxContacts.importContacts'),
	});
	const isImporting = ref(false);

	async function importFile(file: File): Promise<VcardImportOutcome | null> {
		const target = mailboxId.value;
		if (!target || isImporting.value) return null;
		const rejection = vcardFileRejection(file);
		if (rejection) return { kind: 'rejected', reason: rejection };
		isImporting.value = true;
		try {
			const parsed = parseVcards(await file.text());
			if (parsed.entries.length === 0) return { kind: 'rejected', reason: 'empty' };
			let created = 0;
			let merged = 0;
			let kind: 'done' | 'stopped' = 'done';
			for (let start = 0; start < parsed.entries.length; start += VCARD_IMPORT_BATCH_SIZE) {
				const entries = parsed.entries.slice(start, start + VCARD_IMPORT_BATCH_SIZE);
				const result = await importOp.run({ mailboxId: target, entries });
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
		} finally {
			isImporting.value = false;
		}
	}

	/** Write one entry back, as the import would: the Undo of removing an imported row. */
	async function restoreEntry(entry: VcardContactEntry) {
		if (!mailboxId.value) return { ok: false } as const;
		return importOp.run({ mailboxId: mailboxId.value, entries: [vcardEntryOfContact(entry)] });
	}

	function exportContacts(contacts: readonly VcardContactEntry[]): void {
		const contents = serializeVcards(contacts.map(vcardEntryOfContact));
		const url = URL.createObjectURL(new Blob([contents], { type: 'text/vcard;charset=utf-8' }));
		const link = document.createElement('a');
		link.href = url;
		link.setAttribute('download', vcardExportFilename(new Date()));
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	return { isImporting, importFile, restoreEntry, exportContacts };
}
