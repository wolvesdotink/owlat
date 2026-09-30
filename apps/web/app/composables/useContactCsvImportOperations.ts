import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { OperationError } from '@owlat/shared/operationError';
import { operationCopy, resolveOperationCopy } from '~/lib/operationError';
import type { ImportBatchFn, RegisterPropertiesFn } from '~/composables/useCsvImport';

/**
 * The contacts page's two callbacks for `useCsvImport().startImport`, backed by
 * `contacts.importBatch` and `contacts.properties.create`.
 *
 * A failed run comes back as `{ ok: false, reason }` and is never flattened into
 * an all-zero success: the composable needs the failure to account for the
 * batch's rows and to stop before writing contacts whose properties are not
 * registered. `onError` only records the reason and returns `false`, so the
 * operation module's toast, redirect and telemetry still apply.
 */
export function useContactCsvImportOperations(existingPropertyKeys: () => readonly string[]) {
	const { t, te, locale } = useI18n();

	// Set by `onError` while a run is settling. Batches and registrations run one
	// at a time, so the last failure is always the current run's.
	let failure: string | null = null;
	const recordFailure = (op: OperationError) => {
		failure = resolveOperationCopy(
			operationCopy(op, { locale: locale.value, hasMessage: (key: string) => te(key) }),
			(key) => t(key)
		);
		return false;
	};
	const takeFailure = () => {
		const reason = failure ?? t('shared.useCsvImport.errors.importFailed');
		failure = null;
		return reason;
	};

	const { run: importContacts } = useBackendOperation(api.contacts.contacts.importBatch, {
		label: () => t('dashboard.audience.contacts.index.operations.importContacts'),
		onError: recordFailure,
	});
	const { run: createProperty } = useBackendOperation(api.contacts.properties.create, {
		label: () => t('dashboard.audience.contacts.index.operations.registerProperty'),
		onError: recordFailure,
	});

	const importBatch: ImportBatchFn = async (contacts, handleDuplicates, options) => {
		failure = null;
		const outcome = await importContacts({
			contacts,
			handleDuplicates,
			topicId: options?.topicId as Id<'topics'> | undefined,
			contactListAssignments: options?.contactListAssignments as
				| Array<{ email: string; topicIds: Id<'topics'>[] }>
				| undefined,
		});
		return outcome.ok ? { ok: true, result: outcome.result } : { ok: false, reason: takeFailure() };
	};

	// CSV is an operator import source: the backend drops property values for
	// keys that are not already registered. Register any mapped custom-column
	// keys that don't yet exist (string type — CSV cells are strings) before the
	// contact rows are imported, and stop at the first one that fails.
	const registerProperties: RegisterPropertiesFn = async (keys) => {
		const existing = new Set(existingPropertyKeys());
		for (const key of keys) {
			if (existing.has(key)) continue;
			failure = null;
			const outcome = await createProperty({ key, label: key, type: 'string' });
			if (!outcome.ok) return { ok: false, reason: takeFailure() };
		}
		return { ok: true, result: undefined };
	};

	return { importBatch, registerProperties };
}
