import { useCsvFileIntake } from '~/composables/csvImport/useCsvFileIntake';
import { useCsvImportRun } from '~/composables/csvImport/useCsvImportRun';
import type {
	HandleDuplicates,
	ImportResults,
	ImportStep,
	ListAssignmentMode,
	NotImportedRow,
	PreparedContact,
	ValidationResult,
} from '~/composables/csvImport/types';
import {
	assignColumnField,
	conflictingScalarField,
	detectColumnMapping,
	prepareCsvRows,
	scalarFieldOwners,
	type ColumnMapping,
	type MappableField,
	type PreparedRow,
} from '~/utils/csvImportMapping';

export type {
	ContactImport,
	ContactPropertyValue,
	MappableField,
	PreparedRow,
} from '~/utils/csvImportMapping';

export type {
	ContactListAssignment,
	HandleDuplicates,
	ImportBatchFn,
	ImportBatchOutcome,
	ImportResults,
	ImportStep,
	ListAssignmentMode,
	NotImportedRow,
	PreparationOutcome,
	RegisterPropertiesFn,
	ValidationResult,
} from '~/composables/csvImport/types';

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

/** Data rows the preview step shows. */
const PREVIEW_ROW_COUNT = 5;

export function useCsvImport() {
	const { t } = useI18n();
	const isOpen = ref(false);
	const step = ref<ImportStep>('upload');
	const error = ref('');

	// File state
	const selectedFile = ref<File | null>(null);
	// The parsed cells are never edited in place, only replaced as a whole, so
	// they stay out of deep reactivity: no proxy per row or per cell.
	const parsedData = shallowRef<string[][]>([]);
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
	 * Every data row as the import will send it. Validation and the payload read
	 * this; it is computed lazily, so a mapping change only prepares the whole
	 * file once validation or the import asks for it.
	 */
	const preparedRows = computed<PreparedRow[]>(() =>
		prepareCsvRows(parsedData.value, csvHeaders.value, columnMapping.value)
	);
	/**
	 * The first rows through the same `prepareCsvRows`. A row's status only
	 * depends on the rows before it, so this equals the head of `preparedRows`:
	 * what the preview shows is what gets imported.
	 */
	const previewRows = computed<PreparedRow[]>(() =>
		prepareCsvRows(
			parsedData.value.slice(0, PREVIEW_ROW_COUNT),
			csvHeaders.value,
			columnMapping.value
		)
	);
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

	const {
		fileInputRef,
		dropRootRef,
		isDragging,
		handleFileSelect,
		triggerFileInput,
		handleDragOver,
		handleDragLeave,
		handleDrop,
	} = useCsvFileIntake({ step, error, selectedFile, parsedData, csvHeaders, autoDetectMapping });

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

	const { getMappedPropertyKeys, startImport, retryFailedRows } = useCsvImportRun({
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
	});

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
