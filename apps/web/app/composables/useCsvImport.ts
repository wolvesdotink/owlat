import { normalizeEmail } from '@owlat/shared';
import { parseCsvFile } from '~/utils/contactsCsv';
import { useDropZone } from '~/composables/useDropZone';
import { useNativeFilePicker } from '~/composables/useNativeFilePicker';

export type ImportStep =
	| 'upload'
	| 'mapping'
	| 'listMapping'
	| 'preview'
	| 'importing'
	| 'complete';
export type MappableField =
	| 'email'
	| 'firstName'
	| 'lastName'
	| 'language'
	| 'topic'
	| 'property'
	| 'ignore';

export type ContactPropertyValue = string | number | boolean | null;
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

export interface ContactImport {
	email: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	properties?: Record<string, ContactPropertyValue>;
}

export interface ContactListAssignment {
	email: string;
	topicIds: string[];
}

export interface ValidationResult {
	validCount: number;
	invalidEmails: { row: number; email: string }[];
	duplicateEmails: { row: number; email: string }[];
	missingEmails: number[];
	totalRows: number;
}

export const mappableFields: { value: MappableField; label: string }[] = [
	{ value: 'email', label: 'Email (required)' },
	{ value: 'firstName', label: 'First Name' },
	{ value: 'lastName', label: 'Last Name' },
	{ value: 'language', label: 'Language' },
	{ value: 'topic', label: 'Topic' },
	{ value: 'property', label: 'Custom property' },
	{ value: 'ignore', label: '— Ignore this column' },
];

export function useCsvImport() {
	const isOpen = ref(false);
	const step = ref<ImportStep>('upload');
	const error = ref('');

	// File state
	const fileInputRef = ref<HTMLInputElement | null>(null);
	const selectedFile = ref<File | null>(null);
	const parsedData = ref<string[][]>([]);
	const csvHeaders = ref<string[]>([]);

	// Mapping state
	const columnMapping = ref<Record<number, MappableField>>({});
	const handleDuplicates = ref<HandleDuplicates>('skip');

	// Validation state
	const validation = ref<ValidationResult | null>(null);

	// Progress state
	const progress = ref(0);
	const results = ref<ImportResults | null>(null);

	// Topic assignment state
	const listAssignmentMode = ref<ListAssignmentMode>('none');
	const selectedTopicId = ref<string | null>(null);
	const detectedListNames = ref<string[]>([]);
	const listNameMapping = ref<Record<string, string | null>>({});

	// Computed
	const isEmailMapped = computed(() => Object.values(columnMapping.value).includes('email'));
	const isTopicMapped = computed(() => Object.values(columnMapping.value).includes('topic'));
	const previewRows = computed(() => parsedData.value.slice(0, 5));
	const totalRowCount = computed(() => parsedData.value.length);
	const validContactCount = computed(() => validation.value?.validCount ?? 0);
	const hasValidationWarnings = computed(() => {
		if (!validation.value) return false;
		const v = validation.value;
		return v.invalidEmails.length > 0 || v.duplicateEmails.length > 0 || v.missingEmails.length > 0;
	});
	const canImport = computed(() => validContactCount.value > 0);

	const mappedListCount = computed(() => {
		return Object.values(listNameMapping.value).filter((v) => v !== null).length;
	});

	const skippedListCount = computed(() => {
		return Object.values(listNameMapping.value).filter((v) => v === null).length;
	});

	// Auto-detect column mapping based on header names
	const autoDetectMapping = () => {
		const mapping: Record<number, MappableField> = {};

		csvHeaders.value.forEach((header, index) => {
			const headerLower = header.toLowerCase().trim();

			if (headerLower === 'email' || headerLower === 'e-mail' || headerLower.includes('email')) {
				mapping[index] = 'email';
			} else if (['first name', 'firstname', 'first_name', 'given name'].includes(headerLower)) {
				mapping[index] = 'firstName';
			} else if (
				['last name', 'lastname', 'last_name', 'family name', 'surname'].includes(headerLower)
			) {
				mapping[index] = 'lastName';
			} else if (['language', 'lang', 'locale', 'preferred_language'].includes(headerLower)) {
				mapping[index] = 'language';
			} else if (
				[
					'list',
					'topic',
					'topics',
					'mailing list',
					'mailing_list',
					'mailinglist',
					'lists',
				].includes(headerLower)
			) {
				mapping[index] = 'topic';
			} else {
				mapping[index] = 'ignore';
			}
		});

		columnMapping.value = mapping;
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
			error.value = `CSV parsing error: ${message}`;
			return;
		}

		if (data.length < 2) {
			error.value = 'CSV file must have at least a header row and one data row';
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
		acceptCsvFile(input.files?.[0], 'Please select a CSV file');
	};

	// Trigger file selection: the native OS picker (filtered to `.csv`) on
	// desktop, the HTML `<input type=file>` on web.
	const { isDesktop, pickNativeFiles } = useNativeFilePicker();
	const triggerFileInput = () => {
		if (isDesktop.value) {
			void pickNativeFiles({
				title: 'Choose a CSV file',
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			}).then((files) => acceptCsvFile(files[0], 'Please select a CSV file'));
			return;
		}
		fileInputRef.value?.click();
	};

	// Drag and drop handlers (shared zone primitive). The dropped file must be a
	// `.csv`; the zone's `isDragOver` is mirrored to the existing `isDragging`
	// flag so callers/templates keep their current binding. On desktop, OS-level
	// drops are accepted too, scoped to the drop element via `dropRootRef`.
	const dropRootRef = ref<HTMLElement | null>(null);
	const dropZone = useDropZone((files) => acceptCsvFile(files[0], 'Please drop a CSV file'), {
		osFileDrop: true,
		rootRef: dropRootRef,
	});
	const isDragging = dropZone.isDragOver;
	const handleDragOver = dropZone.handleDragOver;
	const handleDragLeave = dropZone.handleDragLeave;
	const handleDrop = dropZone.handleDrop;

	// Validate contacts against the current mapping
	const validateContacts = (): ValidationResult => {
		const emailColumnIndex = Object.entries(columnMapping.value).find(
			([, field]) => field === 'email'
		)?.[0];
		const emailIdx = emailColumnIndex !== undefined ? parseInt(emailColumnIndex, 10) : -1;

		const result: ValidationResult = {
			validCount: 0,
			invalidEmails: [],
			duplicateEmails: [],
			missingEmails: [],
			totalRows: parsedData.value.length,
		};

		const seenEmails = new Set<string>();

		for (let i = 0; i < parsedData.value.length; i++) {
			const row = parsedData.value[i]!;
			const rawEmail = emailIdx >= 0 ? row[emailIdx] : undefined;
			const email = rawEmail?.trim() ?? '';
			const rowNum = i + 1; // 1-based for display

			if (!email) {
				result.missingEmails.push(rowNum);
				continue;
			}

			// Basic email validation: must have @ with something before and a . after @
			const atIndex = email.indexOf('@');
			const isValid =
				atIndex > 0 &&
				email.indexOf('.', atIndex) > atIndex + 1 &&
				email.indexOf('.', atIndex) < email.length - 1;

			if (!isValid) {
				result.invalidEmails.push({ row: rowNum, email });
				continue;
			}

			const normalizedEmail = email.toLowerCase();
			if (seenEmails.has(normalizedEmail)) {
				result.duplicateEmails.push({ row: rowNum, email });
				continue;
			}

			seenEmails.add(normalizedEmail);
			result.validCount++;
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
			error.value = 'You must map a column to Email (required)';
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

	// Get mapped value from row
	const getMappedValue = (row: string[], field: MappableField): string => {
		for (const [indexStr, mappedField] of Object.entries(columnMapping.value)) {
			if (mappedField === field) {
				return row[parseInt(indexStr, 10)] || '—';
			}
		}
		return '—';
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

	// Transform parsed data to contacts
	const getContactsFromParsedData = (): ContactImport[] => {
		const contacts: ContactImport[] = [];

		for (const row of parsedData.value) {
			const contact: ContactImport = { email: '' };
			const properties: Record<string, ContactPropertyValue> = {};

			for (const [indexStr, field] of Object.entries(columnMapping.value)) {
				const index = parseInt(indexStr, 10);
				const value = row[index]?.trim();

				if (field === 'email' && value) {
					contact.email = value;
				} else if (field === 'firstName' && value) {
					contact.firstName = value;
				} else if (field === 'lastName' && value) {
					contact.lastName = value;
				} else if (field === 'language' && value) {
					contact.language = value;
				} else if (field === 'property' && value) {
					// CSV header is the property key; CSV cells are always strings.
					const key = csvHeaders.value[index]?.trim();
					if (key) properties[key] = value;
				}
			}

			if (contact.email) {
				if (Object.keys(properties).length > 0) {
					contact.properties = properties;
				}
				contacts.push(contact);
			}
		}

		return contacts;
	};

	// Build per-contact list assignments from CSV data + listNameMapping
	const getContactListAssignments = (): ContactListAssignment[] => {
		if (listAssignmentMode.value !== 'column') return [];

		const listColumnIndex = Object.entries(columnMapping.value).find(
			([, field]) => field === 'topic'
		)?.[0];
		if (listColumnIndex === undefined) return [];

		const listIdx = parseInt(listColumnIndex, 10);
		const emailColumnIndex = Object.entries(columnMapping.value).find(
			([, field]) => field === 'email'
		)?.[0];
		if (emailColumnIndex === undefined) return [];

		const emailIdx = parseInt(emailColumnIndex, 10);
		const assignments: ContactListAssignment[] = [];

		for (const row of parsedData.value) {
			const rawEmail = row[emailIdx];
			const email = rawEmail ? normalizeEmail(rawEmail) : undefined;
			if (!email) continue;

			const cellValue = row[listIdx]?.trim();
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

	// Start import
	const startImport = async (
		importFn: (
			contacts: ContactImport[],
			handleDuplicates: HandleDuplicates,
			options?: {
				topicId?: string;
				contactListAssignments?: ContactListAssignment[];
			}
		) => Promise<ImportResults>,
		// Optional pre-import hook to register the custom-property keys mapped in
		// this import. CSV is an operator source, so the backend silently drops
		// values for unregistered keys — registering them first is what makes
		// mapped custom columns actually land.
		registerProperties?: (keys: string[]) => Promise<void>
	) => {
		step.value = 'importing';
		progress.value = 0;
		error.value = '';

		const contacts = getContactsFromParsedData();

		if (contacts.length === 0) {
			error.value = 'No valid contacts found in CSV';
			step.value = 'mapping';
			return;
		}

		if (registerProperties) {
			const propertyKeys = getMappedPropertyKeys();
			if (propertyKeys.length > 0) {
				await registerProperties(propertyKeys);
			}
		}

		// Determine list assignment options
		const listOptions: {
			topicId?: string;
			contactListAssignments?: ContactListAssignment[];
		} = {};

		if (listAssignmentMode.value === 'global' && selectedTopicId.value) {
			listOptions.topicId = selectedTopicId.value;
		} else if (listAssignmentMode.value === 'column') {
			listOptions.contactListAssignments = getContactListAssignments();
		}

		try {
			// Process in batches
			const batchSize = 100;
			const totalBatches = Math.ceil(contacts.length / batchSize);
			const aggregatedResults: ImportResults = {
				imported: 0,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
				addedToList: 0,
			};

			for (let i = 0; i < totalBatches; i++) {
				const batch = contacts.slice(i * batchSize, (i + 1) * batchSize);

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

				const batchResults = await importFn(batch, handleDuplicates.value, batchListOptions);

				aggregatedResults.imported += batchResults.imported;
				aggregatedResults.updated += batchResults.updated;
				aggregatedResults.skipped += batchResults.skipped;
				aggregatedResults.failed += batchResults.failed;
				aggregatedResults.errors.push(...batchResults.errors.slice(0, 10));
				aggregatedResults.addedToList =
					(aggregatedResults.addedToList ?? 0) + (batchResults.addedToList ?? 0);

				progress.value = Math.round(((i + 1) / totalBatches) * 100);
			}

			results.value = aggregatedResults;
			step.value = 'complete';

			return aggregatedResults;
		} catch (err) {
			error.value = err instanceof Error ? err.message : 'Import failed';
			step.value = 'mapping';
			throw err;
		}
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
		validation,
		progress,
		results,

		// Topic state
		listAssignmentMode,
		selectedTopicId,
		detectedListNames,
		listNameMapping,

		// Computed
		isEmailMapped,
		isTopicMapped,
		previewRows,
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
		getMappedValue,
		getMappedPropertyKeys,
		startImport,
	};
}
