/**
 * The CSV import's shared shapes. `useCsvImport` re-exports the public ones, so
 * callers keep importing them from `~/composables/useCsvImport`.
 */
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import type { ContactImport } from '~/utils/csvImportMapping';

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

export interface PreparedContact {
	/** 1-based data-row number. */
	row: number;
	contact: ContactImport;
}
