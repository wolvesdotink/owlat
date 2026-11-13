<script setup lang="ts">
import { PlusIcon, TrashIcon } from '@coolicons/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';
import SettingsAccordion from './SettingsAccordion.vue';
import { useRenderOptionsDraft } from './useRenderOptionsDraft';

const { t } = useBuilderI18n();

const { local, emitUpdate, addVariable, removeVariable } = useRenderOptionsDraft();
</script>

<template>
	<SettingsAccordion>
		<template #title>
			{{ t('builder.preview.renderOptions.variables') }}
			<span v-if="local.variableValues.length > 0" class="ep-settings-accordion-count">
				{{ local.variableValues.length }}
			</span>
		</template>

		<div v-for="(variable, idx) in local.variableValues" :key="idx" class="ep-settings-kv-row">
			<input
				v-model="variable.key"
				type="text"
				class="ep-settings-input ep-settings-kv-key"
				:aria-label="t('builder.preview.renderOptions.variableNameOf', { index: idx + 1 })"
				:placeholder="t('builder.preview.renderOptions.variableName')"
				@change="emitUpdate()"
			/>
			<input
				v-model="variable.value"
				type="text"
				class="ep-settings-input ep-settings-kv-value"
				:aria-label="
					variable.key
						? t('builder.preview.renderOptions.variableValueOf', { name: variable.key })
						: t('builder.preview.renderOptions.variableValueOfIndex', { index: idx + 1 })
				"
				:placeholder="t('builder.preview.renderOptions.variableValue')"
				@change="emitUpdate()"
			/>
			<button
				type="button"
				class="ep-settings-list-remove"
				:aria-label="
					variable.key
						? t('builder.preview.renderOptions.removeVariable', { name: variable.key })
						: t('builder.preview.renderOptions.removeVariableIndex', { index: idx + 1 })
				"
				@click="removeVariable(idx)"
			>
				<TrashIcon class="ep-settings-list-remove-icon" aria-hidden="true" />
			</button>
		</div>
		<button type="button" class="ep-settings-list-add" @click="addVariable">
			<PlusIcon class="ep-settings-list-add-icon" aria-hidden="true" />
			{{ t('builder.preview.renderOptions.addVariable') }}
		</button>
	</SettingsAccordion>
</template>

<style scoped src="./fields.css"></style>

<style scoped>
.ep-settings-accordion-count {
	padding: 0 5px;
	background: var(--ep-bg-surface);
	border-radius: 8px;
	font-size: 10px;
	color: var(--ep-text-tertiary);
}

/* Key-value rows */
.ep-settings-kv-row {
	display: flex;
	gap: 6px;
	align-items: center;
}

.ep-settings-kv-key {
	flex: 1;
}

.ep-settings-kv-value {
	flex: 1;
}
</style>
