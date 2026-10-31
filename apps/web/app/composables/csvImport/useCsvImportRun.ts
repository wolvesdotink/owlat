/**
 * The CSV import's send path: the payload built from the prepared rows and the
 * topic assignment, the batched run, and the retry of what a failed batch left
 * behind. `useCsvImport` owns the state and hands its refs in.
 */
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { normalizeEmail } from '@owlat/shared';
import type { ColumnMapping, PreparedRow } from '~/utils/csvImportMapping';
import type {
	ContactListAssignment,
	HandleDuplicates,
	ImportBatchFn,
	ImportResults,
	ImportStep,
	ListAssignmentMode,
	PreparedContact,
	RegisterPropertiesFn,
} from '~/composables/csvImport/types';

/** Rows per `importBatch` call, well under the backend's per-call cap. */
const IMPORT_BATCH_SIZE = 100;

export interface CsvImportRunState {
	step: Ref<ImportStep>;
	error: Ref<string>;
	parsedData: ShallowRef<string[][]>;
	csvHeaders: Ref<string[]>;
	columnMapping: Ref<ColumnMapping>;
	handleDuplicates: Ref<HandleDuplicates>;
	preparedRows: ComputedRef<PreparedRow[]>;
	progress: Ref<number>;
	results: Ref<ImportResults | null>;
	pendingContacts: ShallowRef<PreparedContact[]>;
	failedBatch: Ref<{ size: number; reason: string } | null>;
	listAssignmentMode: Ref<ListAssignmentMode>;
	selectedTopicId: Ref<string | null>;
	listNameMapping: Ref<Record<string, string | null>>;
}

export function useCsvImportRun(state: CsvImportRunState) {
	const { t } = useI18n();
	const {
		step,
		error,
		parsedData,
		csvHeaders,
		columnMapping,
		handleDuplicates,
		preparedRows,
		progress,
		results,
		pendingContacts,
		failedBatch,
		listAssignmentMode,
		selectedTopicId,
		listNameMapping,
	} = state;

	// Distinct property keys for every column mapped to 'property'. The CSV
	// header text is the property key (and label). Used to pre-register the
	// keys before import — CSV is an "operator" import source, so the backend
	// drops property values whose key is not already registered.
	const getMappedPropertyKeys = (): string[] => {
		const keys = new Set<string>();
		for (const [indexStr, field] of Object.entries(columnMapping.value)) {
			if (field !== 'property') continue;
			const key = csvHeaders.value[parseInt(indexStr, 10)]?.trim();
			if (key) keys.add(key);
		}
		return Array.from(keys);
	};

	// The prepared rows that carry an email, each tagged with the data row it
	// came from so a failed batch can name its rows. Rows without an email are
	// not sent at all; `startImport` counts them as skipped.
	const getContactsFromParsedData = (): PreparedContact[] =>
		preparedRows.value
			.filter((prepared) => prepared.contact.email)
			.map(({ row, contact }) => ({ row, contact }));

	// Build per-contact list assignments from CSV data + listNameMapping
	const getContactListAssignments = (): ContactListAssignment[] => {
		if (listAssignmentMode.value !== 'column') return [];

		const listColumnIndex = Object.entries(columnMapping.value).find(
			([, field]) => field === 'topic'
		)?.[0];
		if (listColumnIndex === undefined) return [];

		const listIdx = parseInt(listColumnIndex, 10);
		const assignments: ContactListAssignment[] = [];

		for (const { row, contact } of preparedRows.value) {
			if (!contact.email) continue;
			const email = normalizeEmail(contact.email);

			const cellValue = parsedData.value[row - 1]?.[listIdx]?.trim();
			if (!cellValue) continue;

			const names = cellValue
				.split(',')
				.map((n) => n.trim())
				.filter(Boolean);
			const listIds: string[] = [];

			for (const name of names) {
				const mappedId = listNameMapping.value[name];
				if (mappedId) {
					listIds.push(mappedId);
				}
			}

			if (listIds.length > 0) {
				assignments.push({ email, topicIds: listIds });
			}
		}

		return assignments;
	};

	const listOptionsForImport = (): {
		topicId?: string;
		contactListAssignments?: ContactListAssignment[];
	} => {
		if (listAssignmentMode.value === 'global' && selectedTopicId.value) {
			return { topicId: selectedTopicId.value };
		}
		if (listAssignmentMode.value === 'column') {
			return { contactListAssignments: getContactListAssignments() };
		}
		return {};
	};

	// A throwing callback is folded into the same failure arm as `{ ok: false }`,
	// so both leave the same accounting behind.
	const settle = async <T extends { ok: boolean }>(
		attempt: () => Promise<T>
	): Promise<T | { ok: false; reason: string }> => {
		try {
			return await attempt();
		} catch (err) {
			return {
				ok: false,
				reason: err instanceof Error ? err.message : t('shared.useCsvImport.errors.importFailed'),
			};
		}
	};

	const failureReason = (outcome: { ok: false; reason?: string }) =>
		outcome.reason || t('shared.useCsvImport.errors.importFailed');

	/**
	 * Send `queue` in batches, adding each committed batch to `results`.
	 *
	 * Stops at the first failed batch rather than carrying on: a failure is
	 * usually the session, a rate limit or the connection, which the next batch
	 * would hit too (one more toast, or one more login redirect, each). The
	 * failed batch and everything after it become the retry set, so every row
	 * ends up imported, updated, skipped, failed per row, or not imported.
	 */
	const runBatches = async (
		queue: PreparedContact[],
		importFn: ImportBatchFn,
		committed: ImportResults
	) => {
		const listOptions = listOptionsForImport();
		const aggregated: ImportResults = { ...committed, errors: [...committed.errors] };
		pendingContacts.value = [];
		failedBatch.value = null;

		const totalBatches = Math.ceil(queue.length / IMPORT_BATCH_SIZE);
		for (let i = 0; i < totalBatches; i++) {
			const batch = queue
				.slice(i * IMPORT_BATCH_SIZE, (i + 1) * IMPORT_BATCH_SIZE)
				.map((pending) => pending.contact);

			// For per-contact assignments, filter to only emails in this batch
			let batchListOptions = { ...listOptions };
			if (listOptions.contactListAssignments) {
				const batchEmails = new Set(batch.map((c) => normalizeEmail(c.email)));
				batchListOptions = {
					...listOptions,
					contactListAssignments: listOptions.contactListAssignments.filter((a) =>
						batchEmails.has(a.email)
					),
				};
			}

			const outcome = await settle(() => importFn(batch, handleDuplicates.value, batchListOptions));
			if (!outcome.ok) {
				pendingContacts.value = queue.slice(i * IMPORT_BATCH_SIZE);
				failedBatch.value = { size: batch.length, reason: failureReason(outcome) };
				break;
			}

			const batchResults = outcome.result;
			aggregated.imported += batchResults.imported;
			aggregated.updated += batchResults.updated;
			aggregated.skipped += batchResults.skipped;
			aggregated.failed += batchResults.failed;
			aggregated.errors.push(...batchResults.errors.slice(0, 10));
			aggregated.addedToList = (aggregated.addedToList ?? 0) + (batchResults.addedToList ?? 0);

			progress.value = Math.round(((i + 1) / totalBatches) * 100);
		}

		results.value = aggregated;
		step.value = 'complete';
		return aggregated;
	};

	// Start import
	const startImport = async (
		importFn: ImportBatchFn,
		// Optional pre-import hook to register the custom-property keys mapped in
		// this import. CSV is an operator source, so the backend silently drops
		// values for unregistered keys — registering them first is what makes
		// mapped custom columns actually land.
		registerProperties?: RegisterPropertiesFn
	) => {
		// One run at a time: a second call would send the same rows twice.
		if (step.value === 'importing') return;
		step.value = 'importing';
		progress.value = 0;
		error.value = '';

		const contacts = getContactsFromParsedData();

		if (contacts.length === 0) {
			error.value = t('shared.useCsvImport.errors.noValidContacts');
			step.value = 'mapping';
			return;
		}

		if (registerProperties) {
			const propertyKeys = getMappedPropertyKeys();
			if (propertyKeys.length > 0) {
				// Nothing is written until every mapped key is registered: rows sent
				// without their key would land with those columns silently dropped.
				const prepared = await settle(() => registerProperties(propertyKeys));
				if (!prepared.ok) {
					error.value = t('shared.useCsvImport.errors.propertiesFailed', {
						reason: failureReason(prepared),
					});
					step.value = 'preview';
					return;
				}
			}
		}

		return runBatches(contacts, importFn, {
			imported: 0,
			updated: 0,
			// Rows without an email are never sent; the preview already flagged them.
			skipped: parsedData.value.length - contacts.length,
			failed: 0,
			errors: [],
			addedToList: 0,
		});
	};

	/**
	 * Resend the failed batch and the rows after it — never a committed batch —
	 * with the same mapping, duplicate handling and topic assignment. The
	 * properties were registered before the first attempt got this far.
	 */
	const retryFailedRows = async (importFn: ImportBatchFn) => {
		const queue = pendingContacts.value;
		if (step.value === 'importing' || queue.length === 0 || !results.value) return;
		step.value = 'importing';
		progress.value = 0;
		error.value = '';
		return runBatches(queue, importFn, results.value);
	};

	return { getMappedPropertyKeys, startImport, retryFailedRows };
}
