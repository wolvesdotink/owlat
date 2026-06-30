import { isValidEmail, normalizeEmail } from '@owlat/shared';
import { parseCsvFile } from '~/utils/contactsCsv';
import { useDropZone } from '~/composables/useDropZone';

export type BlocklistImportStep = 'upload' | 'preview' | 'importing' | 'complete';

export interface BlocklistImportResults {
	added: number;
	skipped: number;
	errors: string[];
}

/**
 * Parsed, deduped view of the addresses found in an uploaded blocklist file.
 * `valid` is the normalized set that will be sent to `blockedEmails.bulkAdd`;
 * the other buckets are surfaced in the preview so the operator knows what
 * was dropped before they commit.
 */
export interface BlocklistImportValidation {
	valid: string[];
	invalid: string[];
	duplicates: number;
}

// Cap the import so a pathological file can't blow past the bulkAdd mutation's
// per-call work budget. Mirrors the blocklist view cap on the backend.
const MAX_IMPORT_ROWS = 1000;

/**
 * Blocklist file import (the operator equivalent of the contacts CSV import,
 * but far simpler — a suppression list is a flat list of addresses, so there
 * is no column mapping or duplicate-handling policy). Accepts a `.csv` or
 * `.txt` file where the email is the first column / one address per line,
 * validates + dedupes client-side, then hands the normalized set to the
 * already-built `blockedEmails.bulkAdd` mutation.
 */
export function useBlocklistImport() {
	const isOpen = ref(false);
	const step = ref<BlocklistImportStep>('upload');
	const error = ref('');

	const fileInputRef = ref<HTMLInputElement | null>(null);
	const selectedFile = ref<File | null>(null);

	const validation = ref<BlocklistImportValidation | null>(null);
	const results = ref<BlocklistImportResults | null>(null);

	const validCount = computed(() => validation.value?.valid.length ?? 0);
	const canImport = computed(() => validCount.value > 0);

	const reset = () => {
		step.value = 'upload';
		error.value = '';
		selectedFile.value = null;
		isDragging.value = false;
		validation.value = null;
		results.value = null;
	};

	const open = () => {
		reset();
		isOpen.value = true;
	};

	const close = () => {
		isOpen.value = false;
	};

	// Reduce the raw parsed rows to a deduped, validated set of addresses. The
	// first non-empty cell of each row is treated as the email (a single-column
	// list and a "email,reason,notes" export both work); a leading "email"
	// header row is ignored.
	const buildValidation = (rows: string[][]): BlocklistImportValidation => {
		const valid: string[] = [];
		const invalid: string[] = [];
		const seen = new Set<string>();
		let duplicates = 0;

		for (const row of rows) {
			const raw = row.find((cell) => cell.trim() !== '')?.trim();
			if (!raw) continue;

			// Skip a header cell like "email" / "Email Address".
			if (raw.toLowerCase() === 'email' || raw.toLowerCase() === 'email address') {
				continue;
			}

			if (!isValidEmail(raw)) {
				invalid.push(raw);
				continue;
			}

			const normalized = normalizeEmail(raw);
			if (seen.has(normalized)) {
				duplicates++;
				continue;
			}

			seen.add(normalized);
			valid.push(normalized);
		}

		return { valid, invalid, duplicates };
	};

	const ingestFile = async (file: File): Promise<void> => {
		if (!file.name.endsWith('.csv') && !file.name.endsWith('.txt')) {
			error.value = 'Please select a .csv or .txt file';
			return;
		}

		error.value = '';
		selectedFile.value = file;

		// Shared parse (blank-row filter + error mapping); the blocklist-specific
		// caps, validation and messages stay here.
		let data: string[][];
		try {
			data = await parseCsvFile(file);
		} catch (parseError) {
			const message = parseError instanceof Error ? parseError.message : String(parseError);
			error.value = `File parsing error: ${message}`;
			return;
		}

		if (data.length === 0) {
			error.value = 'The file is empty';
			return;
		}

		if (data.length > MAX_IMPORT_ROWS) {
			error.value = `Too many rows (${data.length}). Import at most ${MAX_IMPORT_ROWS} addresses at a time.`;
			return;
		}

		validation.value = buildValidation(data);

		if (validation.value.valid.length === 0) {
			error.value = 'No valid email addresses found in the file';
			return;
		}

		step.value = 'preview';
	};

	const handleFileSelect = async (event: Event) => {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await ingestFile(file);
		// Allow re-selecting the same file after a reset.
		input.value = '';
	};

	const triggerFileInput = () => {
		fileInputRef.value?.click();
	};

	const dropZone = useDropZone((files) => {
		const file = files[0];
		if (file) void ingestFile(file);
	});
	const isDragging = dropZone.isDragOver;
	const handleDragOver = dropZone.handleDragOver;
	const handleDragLeave = dropZone.handleDragLeave;
	const handleDrop = dropZone.handleDrop;

	const goBackToUpload = () => {
		step.value = 'upload';
		validation.value = null;
		selectedFile.value = null;
		error.value = '';
	};

	// Run the import via the supplied `blockedEmails.bulkAdd` runner. Every
	// imported address is a manual block (the operator is asserting "never send
	// here"); the backend de-dupes against rows already present.
	const startImport = async (
		bulkAddFn: (emails: { email: string; reason: 'manual' }[]) => Promise<
			BlocklistImportResults | undefined
		>
	): Promise<BlocklistImportResults | undefined> => {
		if (!validation.value || validation.value.valid.length === 0) return undefined;

		step.value = 'importing';
		error.value = '';

		const payload = validation.value.valid.map((email) => ({
			email,
			reason: 'manual' as const,
		}));

		const res = await bulkAddFn(payload);

		if (res === undefined) {
			// The operation layer already surfaced the error; return to preview.
			step.value = 'preview';
			return undefined;
		}

		results.value = res;
		step.value = 'complete';
		return res;
	};

	return {
		// State
		isOpen,
		step,
		error,
		fileInputRef,
		selectedFile,
		isDragging,
		validation,
		results,

		// Computed
		validCount,
		canImport,

		// Methods
		open,
		close,
		reset,
		handleFileSelect,
		triggerFileInput,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		goBackToUpload,
		startImport,
	};
}
