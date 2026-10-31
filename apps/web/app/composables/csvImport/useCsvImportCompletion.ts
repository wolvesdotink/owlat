/**
 * The CSV import modal's complete step: what failed, what a failed batch left
 * behind, the error download, where "View imported" goes, and adding the rows
 * that just landed to a topic. The modal's footer reads the same state as the
 * step's body, so the modal creates this once and hands it to both.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { useCsvImport } from '~/composables/useCsvImport';
import { buildImportErrorsCsv, downloadCsv } from '~/utils/contactsCsv';

/** How many failures the panel shows before deferring to the download. */
const ERROR_PREVIEW_LIMIT = 5;

/** Same batch size the import itself uses, well under the backend's row cap. */
const ADD_TO_TOPIC_BATCH_SIZE = 100;

export function useCsvImportCompletion(
	csvImport: ReturnType<typeof useCsvImport>,
	getListName: (listId: string) => string
) {
	const { t } = useI18n();
	const { showToast } = useToast();

	const errorRows = computed(() => csvImport.results.value?.errors ?? []);
	const previewedErrorRows = computed(() => errorRows.value.slice(0, ERROR_PREVIEW_LIMIT));
	const hiddenErrorCount = computed(() =>
		Math.max(0, errorRows.value.length - ERROR_PREVIEW_LIMIT)
	);

	// ── A failed batch ──────────────────────────────────────────────────────────

	const notImportedCount = computed(() => csvImport.notImportedRowCount.value);
	const isIncomplete = computed(() => notImportedCount.value > 0);
	/** Rows the backend reported as failed plus the rows it never committed. */
	const failedCount = computed(
		() => (csvImport.results.value?.failed ?? 0) + notImportedCount.value
	);

	/** First and last data row of a slice of the not-imported rows, for the summary lines. */
	const rowSpan = (rows: ReadonlyArray<{ row: number }>) => ({
		count: rows.length,
		first: rows[0]?.row ?? 0,
		last: rows[rows.length - 1]?.row ?? 0,
	});
	const failedBatchRows = computed(() =>
		rowSpan(csvImport.notImportedRows.value.filter((r) => r.attempted))
	);
	const unsentRows = computed(() =>
		rowSpan(csvImport.notImportedRows.value.filter((r) => !r.attempted))
	);

	/** One line per row that did not make it in, so the download names every address. */
	const notImportedErrorLines = computed(() => {
		const reason = csvImport.failedBatch.value?.reason ?? '';
		return csvImport.notImportedRows.value.map((r) =>
			r.attempted
				? t('components.contacts.csvImportModal.complete.notImportedRow', {
						row: r.row,
						email: r.email,
						reason,
					})
				: t('components.contacts.csvImportModal.complete.notSentRow', {
						row: r.row,
						email: r.email,
					})
		);
	});
	const downloadableErrorRows = computed(() => [
		...errorRows.value,
		...notImportedErrorLines.value,
	]);

	/**
	 * The full error list as a file. The on-screen list stays capped — a wall of
	 * 200 red lines is not readable — but nothing that only exists in this modal is
	 * allowed to die with it.
	 */
	const downloadErrorRows = () => {
		if (downloadableErrorRows.value.length === 0) return;
		const stem = csvImport.selectedFile.value?.name.replace(/\.csv$/i, '').trim();
		downloadCsv(
			buildImportErrorsCsv(downloadableErrorRows.value),
			`${stem || 'contacts-import'}-errors.csv`
		);
	};

	// A topic assigned after the fact, from the panel below — it becomes the
	// "view imported" target the same way a topic chosen before the import does.
	const assignedTopicId = ref<string | null>(null);

	/**
	 * The one place the rows that just landed are visible AS A SET: the topic they
	 * were assigned to. The contacts list has no per-import filter (and no
	 * route-driven search), so with no topic in play the honest answer is the whole
	 * list — said out loud on screen rather than pretended away.
	 */
	const importedTopicId = computed<string | null>(() => {
		if (assignedTopicId.value) return assignedTopicId.value;
		if (csvImport.listAssignmentMode.value === 'global') {
			return csvImport.selectedTopicId.value;
		}
		if (csvImport.listAssignmentMode.value === 'column') {
			const mapped = [
				...new Set(Object.values(csvImport.listNameMapping.value).filter((id) => id !== null)),
			];
			// Several mapped topics have no single destination to open.
			return mapped.length === 1 ? mapped[0]! : null;
		}
		return null;
	});

	const viewImported = () => {
		const topicId = importedTopicId.value;
		csvImport.close();
		void navigateTo(
			topicId ? `/dashboard/audience/topics/${topicId}` : '/dashboard/audience/contacts'
		);
	};

	// ── Add the imported contacts to a topic ────────────────────────────────────

	const isAddToTopicOpen = ref(false);
	const addToTopicId = ref('');

	/**
	 * The distinct addresses this import carried, in file order. The results only
	 * carry counts, so the rows are re-derived from the parsed file — `close()` is
	 * what clears it, and the complete step is still open. Rows a failed batch left
	 * behind are left out: `importBatch` would create them, which is the retry's
	 * job, not a topic assignment's.
	 */
	const importedEmails = computed(() => {
		const notImported = new Set(csvImport.notImportedRows.value.map((r) => r.row));
		const seen = new Set<string>();
		const emails: string[] = [];
		for (const { row, contact } of csvImport.preparedRows.value) {
			if (notImported.has(row)) continue;
			const email = contact.email;
			if (!email || seen.has(email.toLowerCase())) continue;
			seen.add(email.toLowerCase());
			emails.push(email);
		}
		return emails;
	});

	/**
	 * Reuses the import's own topic-assignment path (`importBatch` with a topicId,
	 * `skip` so no contact field is rewritten): the rows resolve to the contacts
	 * that were just created and are subscribed to the topic. The bulk
	 * `topics.addContacts` mutation is not usable here — it takes contact ids, and
	 * an import returns counts, not ids.
	 */
	const { run: runAddToTopic, isLoading: isAddingToTopic } = useBackendOperation(
		api.contacts.contacts.importBatch,
		{ label: () => t('components.contacts.csvImportModal.complete.addToTopicOperation') }
	);

	const confirmAddToTopic = async () => {
		const topicId = addToTopicId.value;
		const emails = importedEmails.value;
		if (!topicId || emails.length === 0) return;

		let added = 0;
		for (let i = 0; i < emails.length; i += ADD_TO_TOPIC_BATCH_SIZE) {
			const outcome = await runAddToTopic({
				contacts: emails.slice(i, i + ADD_TO_TOPIC_BATCH_SIZE).map((email) => ({ email })),
				handleDuplicates: 'skip',
				topicId: topicId as Id<'topics'>,
			});
			// A failure has already been surfaced by the operation module.
			if (!outcome.ok) return;
			added += outcome.result.addedToList ?? 0;
		}

		assignedTopicId.value = topicId;
		isAddToTopicOpen.value = false;
		showToast(
			t(
				'components.contacts.csvImportModal.complete.addedToTopic',
				{ count: added, name: getListName(topicId) },
				added
			)
		);
	};

	/** A finished import's follow-ups must never greet the next one. */
	const reset = () => {
		isAddToTopicOpen.value = false;
		addToTopicId.value = '';
		assignedTopicId.value = null;
	};

	return {
		errorRows,
		previewedErrorRows,
		hiddenErrorCount,
		notImportedCount,
		isIncomplete,
		failedCount,
		failedBatchRows,
		unsentRows,
		downloadableErrorRows,
		downloadErrorRows,
		importedTopicId,
		viewImported,
		isAddToTopicOpen,
		addToTopicId,
		isAddingToTopic,
		confirmAddToTopic,
		reset,
	};
}

export type CsvImportCompletion = ReturnType<typeof useCsvImportCompletion>;
