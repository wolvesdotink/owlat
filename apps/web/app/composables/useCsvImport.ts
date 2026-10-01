import { normalizeEmail } from '@owlat/shared';
import { parseCsvFile } from '~/utils/contactsCsv';
import { useDropZone } from '~/composables/useDropZone';
import { useNativeFilePicker } from '~/composables/useNativeFilePicker';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import {
	assignColumnField,
	conflictingScalarField,
	detectColumnMapping,
	prepareCsvRows,
	scalarFieldOwners,
	type ColumnMapping,
	type ContactImport,
	type MappableField,
	type PreparedRow,
} from '~/utils/csvImportMapping';

export type {
	ContactImport,
	ContactPropertyValue,
	MappableField,
	PreparedRow,
} from '~/utils/csvImportMapping';

export type ImportStep =
	| 'upload'
	| 'mapping'
	| 'listMapping'
	| 'preview'
	| 'importing'
	| 'complete';
export type HandleDuplicates = 'skip' | 'update';
export type ListAssignmentMode = 'none' | 'global' | 'column';

export interface ImportResults {
	imported: number;
	updated: number;
	skipped: number;
	failed: number;
	errors: string[];
	addedToList?: number;
}

export interface ContactListAssignment {
	email: string;
	topicIds: string[];
}

/**
 * One batch's outcome, in the operation module's envelope. The failure arm may
 * carry the reason: the module has already toasted it, but the completion step
 * shows it again next to the rows the failure cost.
 */
export type ImportBatchOutcome =
	| BackendOperationResult<ImportResults>
	| { ok: false; reason: string };

/** The same envelope for the pre-import property registration. */
export type PreparationOutcome = BackendOperationResult<void> | { ok: false; reason: string };

export type ImportBatchFn = (
	contacts: ContactImport[],
	handleDuplicates: HandleDuplicates,
	options?: {
		topicId?: string;
		contactListAssignments?: ContactListAssignment[];
	}
) => Promise<ImportBatchOutcome>;

export type RegisterPropertiesFn = (keys: string[]) => Promise<PreparationOutcome>;

/** A CSV data row that did not reach the backend, or reached it in a batch that failed. */
export interface NotImportedRow {
	/** 1-based data-row number, the numbering the preview's warnings use. */
	row: number;
	email: string;
	/** `true` for the rows of the failed batch, `false` for the ones never sent. */
	attempted: boolean;
}

export interface ValidationResult {
	validCount: number;
	invalidEmails: { row: number; email: string }[];
	duplicateEmails: { row: number; email: string }[];
	missingEmails: number[];
	totalRows: number;
}

/** `label` is a message key — the import modal renders each through `t()`. */
export const mappableFields: { value: MappableField; label: string }[] = [
	{ value: 'email', label: 'shared.useCsvImport.fields.email' },
	{ value: 'firstName', label: 'shared.useCsvImport.fields.firstName' },
	{ value: 'lastName', label: 'shared.useCsvImport.fields.lastName' },
	{ value: 'language', label: 'shared.useCsvImport.fields.language' },
	{ value: 'topic', label: 'shared.useCsvImport.fields.topic' },
	{ value: 'property', label: 'shared.useCsvImport.fields.property' },
	{ value: 'ignore', label: 'shared.useCsvImport.fields.ignore' },
];

/** Rows per `importBatch` call, well under the backend's per-call cap. */
const IMPORT_BATCH_SIZE = 100;

interface PreparedContact {
	/** 1-based data-row number. */
	row: number;
	contact: ContactImport;
}

export function useCsvImport() {
	const { t } = useI18n();
	const isOpen = ref(false);
	const step = ref<ImportStep>('upload');
	const error = ref('');

	// File state
	const fileInputRef = ref<HTMLInputElement | null>(null);
	const selectedFile = ref<File | null>(null);
	const parsedData = ref<string[][]>([]);
	const csvHeaders = ref<string[]>([]);

	// Mapping state
	const columnMapping = ref<ColumnMapping>({});
	const handleDuplicates = ref<HandleDuplicates>('skip');

	// Validation state
	const validation = ref<ValidationResult | null>(null);

	// Progress state
	const progress = ref(0);
	// Counters of the batches the backend COMMITTED, cumulative across retries.
	const results = ref<ImportResults | null>(null);
	// The retry set: the failed batch followed by every row after it, in file
	// order. Empty once every row has been through a committed batch.
	const pendingContacts = shallowRef<PreparedContact[]>([]);
	// How many of `pendingContacts` were in the batch that failed, and why.
	const failedBatch = ref<{ size: number; reason: string } | null>(null);

	// Topic assignment state
	const listAssignmentMode = ref<ListAssignmentMode>('none');
	const selectedTopicId = ref<string | null>(null);
	const detectedListNames = ref<string[]>([]);
	const listNameMapping = ref<Record<string, string | null>>({});

	// Computed
	const isEmailMapped = computed(() => Object.values(columnMapping.value).includes('email'));
	const isTopicMapped = computed(() => Object.values(columnMapping.value).includes('topic'));
	/** The column feeding each scalar field (Email, First name, Last name, Language). */
	const scalarOwners = computed(() => scalarFieldOwners(columnMapping.value));
	const mappingConflict = computed(() => conflictingScalarField(columnMapping.value));
	/**
	 * Every data row as the import will send it. Validation, the preview and the
	 * payload all read this, so what the preview shows is what gets imported.
	 */
	const preparedRows = computed<PreparedRow[]>(() =>
		prepareCsvRows(parsedData.value, csvHeaders.value, columnMapping.value)
	);
	const previewRows = computed(() => preparedRows.value.slice(0, 5));
	/** Header of the column the email comes from, for the preview. */
	const emailSourceColumn = computed(() => {
		const owner = scalarOwners.value.email;
		return owner === undefined ? null : (csvHeaders.value[owner] ?? null);
	});
	const totalRowCount = computed(() => parsedData.value.length);
	const validContactCount = computed(() => validation.value?.validCount ?? 0);
	const hasValidationWarnings = computed(() => {
		if (!validation.value) return false;
		const v = validation.value;
		return v.invalidEmails.length > 0 || v.duplicateEmails.length > 0 || v.missingEmails.length > 0;
	});
	const canImport = computed(() => validContactCount.value > 0);

	const notImportedRows = computed<NotImportedRow[]>(() => {
		const attemptedCount = failedBatch.value?.size ?? 0;
		return pendingContacts.value.map((pending, index) => ({
			row: pending.row,
			email: pending.contact.email,
			attempted: index < attemptedCount,
		}));
	});
	const notImportedRowCount = computed(() => pendingContacts.value.length);

	const mappedListCount = computed(() => {
		return Object.values(listNameMapping.value).filter((v) => v !== null).length;
	});

	const skippedListCount = computed(() => {
		return Object.values(listNameMapping.value).filter((v) => v === null).length;
	});

	// Auto-detect column mapping based on header names
	const autoDetectMapping = () => {
		columnMapping.value = detectColumnMapping(csvHeaders.value);
	};

	/**
	 * Map one column. A scalar field another column owns moves here, and that
	 * column falls back to Custom property (Skip for a blank header). Returns the
	 * displaced columns.
	 */
	const mapColumn = (column: number, field: MappableField): number[] => {
		const { mapping, displaced } = assignColumnField(
			columnMapping.value,
			csvHeaders.value,
			column,
			field
		);
		columnMapping.value = mapping;
		return displaced;
	};

	// Reset state
	const reset = () => {
		step.value = 'upload';
		error.value = '';
		selectedFile.value = null;
		parsedData.value = [];
		csvHeaders.value = [];
		columnMapping.value = {};
		handleDuplicates.value = 'skip';
		validation.value = null;
		progress.value = 0;
		results.value = null;
		pendingContacts.value = [];
		failedBatch.value = null;
		isDragging.value = false;
		listAssignmentMode.value = 'none';
		selectedTopicId.value = null;
		detectedListNames.value = [];
		listNameMapping.value = {};
	};

	// Open modal
	const open = () => {
		reset();
		isOpen.value = true;
	};

	// Close modal
	const close = () => {
		isOpen.value = false;
	};

	// Parse a chosen `.csv` file into headers + rows and advance to mapping.
	// Centralizes the parse via `parseCsvFile` (shared blank-row filter + error
	// mapping); the CSV-specific messages and the header/row split stay here.
	const ingestFile = async (file: File): Promise<void> => {
		error.value = '';
		selectedFile.value = file;

		let data: string[][];
		try {
			data = await parseCsvFile(file);
		} catch (parseError) {
			const message = parseError instanceof Error ? parseError.message : String(parseError);
			error.value = t('shared.useCsvImport.errors.parseFailed', { message });
			return;
		}

		if (data.length < 2) {
			error.value = t('shared.useCsvImport.errors.tooFewRows');
			return;
		}

		csvHeaders.value = data[0] ?? [];
		parsedData.value = data.slice(1);
		autoDetectMapping();
		step.value = 'mapping';
	};

	// Guard that a chosen/dropped file is a `.csv` before parsing it, setting
	// `errorMessage` when it isn't. Shared by the `<input>`, the native picker
	// and the drop zone so the "first file → `.csv` guard → error → ingest" flow
	// lives in exactly one place.
	const acceptCsvFile = (file: File | undefined, errorMessage: string) => {
		if (!file) return;
		if (!file.name.endsWith('.csv')) {
			error.value = errorMessage;
			return;
		}
		void ingestFile(file);
	};

	// Handle file selection
	const handleFileSelect = (event: Event) => {
		const input = event.target as HTMLInputElement;
		acceptCsvFile(input.files?.[0], t('shared.useCsvImport.errors.selectCsv'));
	};

	// Trigger file selection: the native OS picker (filtered to `.csv`) on
	// desktop, the HTML `<input type=file>` on web.
	const { isDesktop, pickNativeFiles } = useNativeFilePicker();
	const triggerFileInput = () => {
		if (isDesktop.value) {
			void pickNativeFiles({
				title: t('shared.useCsvImport.pickerTitle'),
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			}).then((files) => acceptCsvFile(files[0], t('shared.useCsvImport.errors.selectCsv')));
			return;
		}
		fileInputRef.value?.click();
	};

	// Drag and drop handlers (shared zone primitive). The dropped file must be a
	// `.csv`; the zone's `isDragOver` is mirrored to the existing `isDragging`
	// flag so callers/templates keep their current binding. On desktop, OS-level
	// drops are accepted too, scoped to the drop element via `dropRootRef`.
	const dropRootRef = ref<HTMLElement | null>(null);
	const dropZone = useDropZone(
		(files) => acceptCsvFile(files[0], t('shared.useCsvImport.errors.dropCsv')),
		{
			osFileDrop: true,
			rootRef: dropRootRef,
		}
	);
	const isDragging = dropZone.isDragOver;
	const handleDragOver = dropZone.handleDragOver;
	const handleDragLeave = dropZone.handleDragLeave;
	const handleDrop = dropZone.handleDrop;

	// Validate contacts against the current mapping, from the prepared rows
	const validateContacts = (): ValidationResult => {
		const result: ValidationResult = {
			validCount: 0,
			invalidEmails: [],
			duplicateEmails: [],
			missingEmails: [],
			totalRows: parsedData.value.length,
		};
		for (const { row, contact, status } of preparedRows.value) {
			if (status === 'missing') result.missingEmails.push(row);
			else if (status === 'invalid') result.invalidEmails.push({ row, email: contact.email });
			else if (status === 'duplicate') result.duplicateEmails.push({ row, email: contact.email });
			else result.validCount++;
		}
		return result;
	};

	// Extract unique list names from CSV column
	const extractListNames = (): string[] => {
		const listColumnIndex = Object.entries(columnMapping.value).find(
			([, field]) => field === 'topic'
		)?.[0];
		if (listColumnIndex === undefined) return [];

		const idx = parseInt(listColumnIndex, 10);
		const namesSet = new Set<string>();

		for (const row of parsedData.value) {
			const cellValue = row[idx]?.trim();
			if (!cellValue) continue;

			// Support comma-separated list names
			const names = cellValue
				.split(',')
				.map((n) => n.trim())
				.filter(Boolean);
			for (const name of names) {
				namesSet.add(name);
			}
		}

		return Array.from(namesSet).sort();
	};

	// Navigate to preview (or listMapping if topic column is mapped)
	const goToPreview = () => {
		if (!isEmailMapped.value) {
			error.value = t('shared.useCsvImport.errors.emailColumnRequired');
			return;
		}
		if (mappingConflict.value) {
			error.value = t('shared.useCsvImport.errors.conflictingMapping', {
				field: t(`shared.useCsvImport.fieldNames.${mappingConflict.value}`),
			});
			return;
		}
		error.value = '';

		// If a column is mapped to topic, detect list names and go to listMapping step
		if (isTopicMapped.value) {
			const names = extractListNames();
			detectedListNames.value = names;
			// Initialize mapping with all names → null (skip)
			const mapping: Record<string, string | null> = {};
			for (const name of names) {
				// Preserve existing mappings if user goes back and forth
				mapping[name] = listNameMapping.value[name] ?? null;
			}
			listNameMapping.value = mapping;
			listAssignmentMode.value = 'column';
			step.value = 'listMapping';
			return;
		}

		validation.value = validateContacts();
		step.value = 'preview';
	};

	// Navigate from listMapping to preview
	const goToPreviewFromListMapping = () => {
		error.value = '';
		validation.value = validateContacts();
		step.value = 'preview';
	};

	// Go back to mapping
	const goBackToMapping = () => {
		step.value = 'mapping';
	};

	// Go back to mapping from listMapping
	const goBackToMappingFromListMapping = () => {
		step.value = 'mapping';
	};

	// Handle global list selection (mutually exclusive with column mapping)
	const selectGlobalTopic = (listId: string | null) => {
		selectedTopicId.value = listId;
		if (listId) {
			listAssignmentMode.value = 'global';
			// Clear any topic column mapping
			for (const [indexStr, field] of Object.entries(columnMapping.value)) {
				if (field === 'topic') {
					columnMapping.value[parseInt(indexStr, 10)] = 'ignore';
				}
			}
		} else {
			listAssignmentMode.value = 'none';
		}
	};

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

	// Watch for column mapping changes — auto-manage list assignment mode
	watch(
		() => Object.values(columnMapping.value),
		() => {
			if (isTopicMapped.value && listAssignmentMode.value === 'global') {
				// Column mapped to topic takes precedence, clear global selection
				selectedTopicId.value = null;
				listAssignmentMode.value = 'column';
			}
		}
	);

	return {
		// State
		isOpen,
		step,
		error,
		fileInputRef,
		dropRootRef,
		selectedFile,
		parsedData,
		csvHeaders,
		isDragging,
		columnMapping,
		handleDuplicates,
		preparedRows,
		validation,
		progress,
		results,
		failedBatch,
		notImportedRows,
		notImportedRowCount,

		// Topic state
		listAssignmentMode,
		selectedTopicId,
		detectedListNames,
		listNameMapping,

		// Computed
		isEmailMapped,
		isTopicMapped,
		scalarOwners,
		mappingConflict,
		previewRows,
		emailSourceColumn,
		totalRowCount,
		validContactCount,
		hasValidationWarnings,
		canImport,
		mappedListCount,
		skippedListCount,

		// Methods
		open,
		close,
		reset,
		handleFileSelect,
		triggerFileInput,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		goToPreview,
		goToPreviewFromListMapping,
		goBackToMapping,
		goBackToMappingFromListMapping,
		selectGlobalTopic,
		mapColumn,
		getMappedPropertyKeys,
		startImport,
		retryFailedRows,
	};
}
