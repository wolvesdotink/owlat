/**
 * vCard import into and export out of the Postbox address book (the personal
 * `mailContacts`, not the audience contacts and their CSV import).
 *
 * The runs themselves (`~/lib/postboxVcardTransfer`) load when one starts, so
 * the parser and serializer stay out of the contacts page's own bundle. The
 * server bounds every imported entry again. Export reads the whole book page
 * by page rather than the rows the contacts page has loaded, which stop at its
 * list cap.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { VcardContactEntry } from '@owlat/shared/postboxVcard';
import type { VcardImportOutcome } from '~/lib/postboxVcardTransfer';

export type { VcardImportOutcome };

const EXPORT_PAGE_SIZE = 500;

const loadTransfer = () => import('~/lib/postboxVcardTransfer');

export function usePostboxVcardTransfer(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const client = useConvex();
	const importOp = useBackendOperation(api.mail.contactsVcard.importBatch, {
		label: () => t('shared.postbox.usePostboxContacts.importContacts'),
	});
	const photosOp = useBackendOperation(api.mail.contactsPhotos.importPhotos, {
		label: () => t('shared.postbox.usePostboxContacts.importPhotos'),
	});
	const isImporting = ref(false);
	const isExporting = ref(false);

	async function importFile(file: File): Promise<VcardImportOutcome | null> {
		const target = mailboxId.value;
		if (!target || isImporting.value) return null;
		isImporting.value = true;
		try {
			const { importVcardFile } = await loadTransfer();
			return await importVcardFile(
				file,
				(entries) => importOp.run({ mailboxId: target, entries }),
				(photos) => photosOp.run({ mailboxId: target, photos })
			);
		} catch {
			// The file could not be read, or the import could not be loaded (offline).
			// A failed batch is not this: `importOp.run` reports and resolves.
			return { kind: 'rejected', reason: 'unreadable' };
		} finally {
			isImporting.value = false;
		}
	}

	/** Write one entry back, as the import would: the Undo of removing an imported row. */
	async function restoreEntry(entry: VcardContactEntry) {
		if (!mailboxId.value) return { ok: false } as const;
		const { email, displayName, organization, phones, postalAddresses } = entry;
		return importOp.run({
			mailboxId: mailboxId.value,
			entries: [{ email, displayName, organization, phones, postalAddresses }],
		});
	}

	/** Download the whole address book as a .vcf file; false when it could not. */
	async function exportBook(): Promise<boolean> {
		const target = mailboxId.value;
		if (!target || !client || isExporting.value) return false;
		isExporting.value = true;
		try {
			const { exportVcardBook } = await loadTransfer();
			await exportVcardBook((cursor) =>
				client.query(api.mail.contactsVcard.exportPage, {
					mailboxId: target,
					paginationOpts: { cursor, numItems: EXPORT_PAGE_SIZE },
				})
			);
			return true;
		} catch {
			return false;
		} finally {
			isExporting.value = false;
		}
	}

	return { isImporting, isExporting, importFile, restoreEntry, exportBook };
}
