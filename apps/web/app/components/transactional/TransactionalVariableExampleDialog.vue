<script setup lang="ts">
/**
 * Edit one data variable's example value. The example is sample data for the
 * editor preview and test sends; no real send reads it, so it saves at once,
 * also while the email is published (`transactional/sendOptions.ts`).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
// The field alone: the package's barrel would pull the whole builder into
// this lazily loaded dialog.
import VariableExampleField from '@owlat/email-builder/variable-example-field';
import type { DataVariableExampleValue } from '@owlat/shared/dataVariableExamples';

const props = defineProps<{
	emailId: Id<'transactionalEmails'>;
	/** The variable being edited; `null` closes the dialog. */
	variable: {
		key: string;
		type: 'string' | 'number' | 'boolean' | 'date' | 'array';
		example?: DataVariableExampleValue;
	} | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const inputId = useId();

const { run: setVariableExample, isLoading } = useBackendOperation(
	api.transactional.sendOptions.setVariableExample,
	{ label: () => t('components.transactional.sendOptions.operations.example') }
);

const value = ref<DataVariableExampleValue | undefined | 'invalid'>(undefined);

async function save() {
	if (!props.variable || value.value === 'invalid') return;
	const result = await setVariableExample({
		id: props.emailId,
		key: props.variable.key,
		...(value.value !== undefined ? { example: value.value } : {}),
	});
	if (result.ok) emit('close');
}
</script>

<template>
	<UiModal
		:open="variable !== null"
		:title="
			t('components.transactional.sendOptions.exampleDialog.title', { name: variable?.key ?? '' })
		"
		@update:open="(open: boolean) => !open && emit('close')"
	>
		<div v-if="variable">
			<label :for="inputId" class="block text-sm font-medium text-text-secondary mb-2">
				{{ t('components.transactional.sendOptions.exampleDialog.label') }}
			</label>
			<VariableExampleField
				:type="variable.type"
				:initial="variable.example"
				:input-id="inputId"
				@change="value = $event"
			/>
		</div>
		<template #footer>
			<UiButton variant="ghost" @click="emit('close')">{{ t('common.cancel') }}</UiButton>
			<UiButton
				:disabled="value === 'invalid' || isLoading"
				data-testid="variable-example-save"
				@click="save"
			>
				{{ t('common.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
