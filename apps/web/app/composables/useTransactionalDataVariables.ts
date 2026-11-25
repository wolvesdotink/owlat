import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';
import type { CreatedVariable, Variable } from '@owlat/email-builder';
import {
	exampleAsPreviewText,
	type DataVariableExampleValue,
} from '@owlat/shared/dataVariableExamples';

/** A declared data variable of a transactional email, with its example value. */
export interface DataVariableInfo {
	key: string;
	type: 'string' | 'number' | 'boolean' | 'date' | 'array';
	/** Sample value for the preview and test sends; a real send never uses it. */
	example?: DataVariableExampleValue;
}

const DATA_VARIABLE_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * The transactional editor's data variables: read from the email's schema and
 * example values, offered to the builder (whose preview shows each example,
 * so a condition shows the branch it selects and a repeated block its rows),
 * and extended by the builder's "new variable" dialog.
 */
export function useTransactionalDataVariables(
	emailId: { readonly value: Id<'transactionalEmails'> },
	email: { readonly value: Doc<'transactionalEmails'> | null | undefined }
) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { run: updateSchema } = useBackendOperation(api.transactional.emails.updateSchema, {
		label: () => t('dashboard.send.transactional.detail.edit.operations.saveVariable'),
	});

	const dataVariables = ref<DataVariableInfo[]>([]);

	watch(
		() => email.value,
		(row) => {
			if (!row?.dataVariablesSchema) return;
			const examples = row.dataVariableExamples ?? {};
			dataVariables.value = Object.entries(row.dataVariablesSchema).map(([key, type]) => ({
				key,
				type,
				...(Object.hasOwn(examples, key) ? { example: examples[key] } : {}),
			}));
		},
		{ immediate: true }
	);

	const variables = computed<Variable[]>(() =>
		dataVariables.value.map((v) => ({
			key: v.key,
			label: v.key,
			type: v.type,
			group: t('dashboard.send.transactional.detail.edit.variableGroup'),
			isBuiltIn: false,
			...(v.example !== undefined ? { previewValue: exampleAsPreviewText(v.example) } : {}),
		}))
	);

	async function createVariable(variable: CreatedVariable) {
		const key = variable.key.trim();
		const type = (variable.type ?? 'string') as DataVariableInfo['type'];
		if (!DATA_VARIABLE_KEY.test(key)) {
			showToast(t('dashboard.send.transactional.detail.edit.toasts.invalidVariableName'), 'error');
			return;
		}
		if (dataVariables.value.some((existing) => existing.key === key)) {
			showToast(t('dashboard.send.transactional.detail.edit.toasts.duplicateVariable'), 'error');
			return;
		}

		const next: DataVariableInfo[] = [
			...dataVariables.value,
			{ key, type, ...(variable.example !== undefined ? { example: variable.example } : {}) },
		];
		dataVariables.value = next;
		const result = await updateSchema({
			id: emailId.value,
			dataVariablesSchema: Object.fromEntries(next.map((v) => [v.key, v.type])),
			// Every example, the new one included: given, they replace the stored set.
			dataVariableExamples: Object.fromEntries(
				next.flatMap((v) => (v.example !== undefined ? [[v.key, v.example]] : []))
			),
		});
		if (!result.ok) {
			// Roll back the optimistic add; the module has toasted the failure.
			dataVariables.value = dataVariables.value.filter((existing) => existing.key !== key);
		}
	}

	return { dataVariables, variables, createVariable };
}
