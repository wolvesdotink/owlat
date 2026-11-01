<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue';
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
				:placeholder="t('builder.preview.renderOptions.variableName')"
				@change="emitUpdate()"
			/>
			<input
				v-model="variable.value"
				type="text"
				class="ep-settings-input ep-settings-kv-value"
				:placeholder="t('builder.preview.renderOptions.variableValue')"
				@change="emitUpdate()"
			/>
			<button class="ep-settings-list-remove" @click="removeVariable(idx)">
				<Trash2 class="ep-settings-list-remove-icon" />
			</button>
		</div>
		<button class="ep-settings-list-add" @click="addVariable">
			<Plus class="ep-settings-list-add-icon" />
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
