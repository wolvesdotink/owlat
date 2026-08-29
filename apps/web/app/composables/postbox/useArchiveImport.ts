/**
 * Upload-based archive import (idea 50) — the wizard's side of the job.
 *
 * Three calls, in the order the user experiences them: mint an upload URL and
 * POST the file (the shared `uploadFileToStorage` helper every other Convex
 * upload uses), hand the stored blob to `mail.archiveImport.start`, then watch
 * `getStatus` while the runner walks it. The status query is live, so the
 * progress bar follows a job that outlives the page — closing the tab does not
 * stop an import, and reopening it finds the same bar where the runner left it.
 *
 * Every decision the card makes about a file (is it importable, what does the
 * summary line say) lives in `~/utils/postboxArchiveImport` so it is testable
 * without a Convex client.
 */

import { api } from '@owlat/api';
import { uploadFileToStorage } from '~/utils/storageUpload';
import { parseGmailFiltersXml, type UntranslatedFilter } from '~/utils/gmailFilterImport';
import {
	archiveFormatForFilename,
	archiveImportRefusalKey,
	archiveRejectionKey,
	isArchiveImportRunning,
	rejectArchiveFile,
	type ArchiveImportJob,
} from '~/utils/postboxArchiveImport';

export function useArchiveImport() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { currentMailbox } = usePostboxMailbox();
	const mailboxId = computed(() => currentMailbox.value?._id ?? null);

	const { data: job } = useConvexQuery(api.mail.archiveImport.getStatus, () => {
		const id = mailboxId.value;
		return id ? { mailboxId: id } : 'skip';
	});

	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.postbox.useArchiveImport.uploadOperation'),
	});
	const startOp = useBackendOperation(api.mail.archiveImport.start, {
		label: () => t('shared.postbox.useArchiveImport.startOperation'),
	});
	const cancelOp = useBackendOperation(api.mail.archiveImport.cancel, {
		label: () => t('shared.postbox.useArchiveImport.cancelOperation'),
	});
	const filtersOp = useBackendOperation(api.mail.filtersImport.importGmailFilters, {
		label: () => t('shared.postbox.useArchiveImport.filtersOperation'),
	});

	const isUploading = ref(false);

	const currentJob = computed<ArchiveImportJob | null>(() => job.value ?? null);
	const isRunning = computed(() => isArchiveImportRunning(currentJob.value));
	// The upload is not part of the job row yet, so the card has to treat it as
	// busy too — otherwise a second file can be picked while the first is still
	// in flight and the server refuses it for no reason the user can see.
	const isBusy = computed(() => isUploading.value || isRunning.value || startOp.isLoading.value);

	/** Upload a chosen file and start importing it. */
	async function importFile(file: File): Promise<boolean> {
		const id = mailboxId.value;
		if (!id) return false;
		const rejection = rejectArchiveFile(file);
		if (rejection) {
			showToast(t(archiveRejectionKey(rejection)), 'error');
			return false;
		}
		const format = archiveFormatForFilename(file.name);
		if (!format) return false;

		isUploading.value = true;
		try {
			const uploaded = await uploadFileToStorage(
				file,
				() => generateUploadUrl({}),
				file.type || 'application/octet-stream'
			);
			if (!uploaded.ok) {
				// A failed mint has already been toasted by the operation module; the
				// two transport failures have not.
				if (uploaded.reason !== 'no-url') {
					showToast(t('shared.postbox.useArchiveImport.uploadFailed'), 'error');
				}
				return false;
			}
			const started = await startOp.run({
				mailboxId: id,
				storageId: uploaded.storageId,
				filename: file.name,
				format,
				totalBytes: file.size,
			});
			if (!started.ok) return false;
			// A refusal is a normal answer here, not an error: the mutation returns
			// it so it can delete the upload in the same transaction.
			if (!started.result.ok) {
				showToast(t(archiveImportRefusalKey(started.result.reason)), 'error');
				return false;
			}
			showToast(t('shared.postbox.useArchiveImport.started'), 'success');
			return true;
		} catch {
			showToast(t('shared.postbox.useArchiveImport.uploadFailed'), 'error');
			return false;
		} finally {
			isUploading.value = false;
		}
	}

	/**
	 * Rules Gmail exported that Owlat could not express, kept after the import so
	 * the card can name them. An import that silently created four of someone's
	 * eleven filters would be worse than one that created none.
	 */
	const untranslatedFilters = ref<UntranslatedFilter[]>([]);

	/** Translate a Gmail filter export and create what survives. */
	async function importFilters(file: File): Promise<boolean> {
		const id = mailboxId.value;
		if (!id) return false;
		const plan = parseGmailFiltersXml(await file.text());
		untranslatedFilters.value = plan.untranslated;
		if (plan.filters.length === 0) {
			showToast(t('shared.postbox.useArchiveImport.filtersNoneFound'), 'error');
			return false;
		}
		const result = await filtersOp.run({ mailboxId: id, filters: plan.filters });
		if (!result.ok) return false;
		showToast(
			t('shared.postbox.useArchiveImport.filtersImported', {
				created: result.result.created,
				skipped: result.result.skipped,
			}),
			'success'
		);
		return true;
	}

	/** Stop the running import. Mail it already landed stays imported. */
	async function cancelImport(): Promise<void> {
		const importId = currentJob.value && job.value ? job.value._id : null;
		if (!importId) return;
		const result = await cancelOp.run({ importId });
		if (result.ok && result.result) {
			showToast(t('shared.postbox.useArchiveImport.cancelled'), 'success');
		}
	}

	return {
		mailboxId,
		job: currentJob,
		isRunning,
		isBusy,
		isUploading,
		isCancelling: cancelOp.isLoading,
		isImportingFilters: filtersOp.isLoading,
		untranslatedFilters,
		importFile,
		importFilters,
		cancelImport,
	};
}
