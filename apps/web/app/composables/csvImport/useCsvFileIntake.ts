/**
 * How a `.csv` reaches the import: the `<input>`, the desktop's native picker
 * and the drop zone all funnel into one parse that fills the headers and rows
 * `useCsvImport` owns, then advances to the mapping step.
 */
import type { Ref, ShallowRef } from 'vue';
import { parseCsvFile } from '~/utils/contactsCsv';
import { useDropZone } from '~/composables/useDropZone';
import { useNativeFilePicker } from '~/composables/useNativeFilePicker';
import type { ImportStep } from '~/composables/csvImport/types';

export interface CsvFileIntakeState {
	step: Ref<ImportStep>;
	error: Ref<string>;
	selectedFile: Ref<File | null>;
	parsedData: ShallowRef<string[][]>;
	csvHeaders: Ref<string[]>;
	/** Fills the column mapping from the freshly parsed headers. */
	autoDetectMapping: () => void;
}

export function useCsvFileIntake(state: CsvFileIntakeState) {
	const { t } = useI18n();
	const { step, error, selectedFile, parsedData, csvHeaders, autoDetectMapping } = state;

	const fileInputRef = ref<HTMLInputElement | null>(null);

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

	return {
		fileInputRef,
		dropRootRef,
		isDragging: dropZone.isDragOver,
		handleFileSelect,
		triggerFileInput,
		handleDragOver: dropZone.handleDragOver,
		handleDragLeave: dropZone.handleDragLeave,
		handleDrop: dropZone.handleDrop,
	};
}
