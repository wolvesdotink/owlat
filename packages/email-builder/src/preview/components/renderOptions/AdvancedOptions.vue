<script setup lang="ts">
import { PlusIcon, TrashIcon } from '@coolicons/vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';
import SettingsAccordion from './SettingsAccordion.vue';
import { useRenderOptionsDraft } from './useRenderOptionsDraft';

const { t } = useBuilderI18n();

const { local, emitUpdate, addFontUrl, removeFontUrl } = useRenderOptionsDraft();
</script>

<template>
	<SettingsAccordion>
		<template #title>{{ t('builder.preview.renderOptions.advanced') }}</template>

		<!-- Breakpoint -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{ t('builder.preview.renderOptions.breakpoint') }}</label>
			<input
				v-model.number="local.breakpoint"
				type="number"
				class="ep-settings-input ep-settings-input-number"
				:min="320"
				:max="768"
				@change="emitUpdate()"
			/>
		</div>

		<!-- Language -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{ t('builder.preview.renderOptions.language') }}</label>
			<input
				v-model="local.lang"
				type="text"
				class="ep-settings-input"
				placeholder="en"
				@change="emitUpdate()"
			/>
		</div>

		<!-- Validation Level -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{
				t('builder.preview.renderOptions.validationLevel')
			}}</label>
			<select v-model="local.validationLevel" class="ep-settings-select" @change="emitUpdate()">
				<option value="skip">{{ t('builder.preview.renderOptions.validation.skip') }}</option>
				<option value="soft">{{ t('builder.preview.renderOptions.validation.soft') }}</option>
				<option value="strict">
					{{ t('builder.preview.renderOptions.validation.strict') }}
				</option>
			</select>
		</div>

		<!-- Title -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{ t('builder.preview.renderOptions.emailTitle') }}</label>
			<input
				v-model="local.title"
				type="text"
				class="ep-settings-input"
				:placeholder="t('builder.preview.renderOptions.emailTitlePlaceholder')"
				@change="emitUpdate()"
			/>
		</div>

		<!-- Preheader Text -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{ t('builder.preview.renderOptions.preheader') }}</label>
			<input
				v-model="local.preheaderText"
				type="text"
				class="ep-settings-input"
				:placeholder="t('builder.preview.renderOptions.preheaderPlaceholder')"
				@change="emitUpdate()"
			/>
		</div>

		<!-- Custom CSS -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{ t('builder.preview.renderOptions.customCss') }}</label>
			<textarea
				v-model="local.customCss"
				class="ep-settings-textarea"
				rows="4"
				placeholder=".custom-class { color: red; }"
				@change="emitUpdate()"
			></textarea>
		</div>

		<!-- Font URLs -->
		<div class="ep-settings-field">
			<label class="ep-settings-label">{{ t('builder.preview.renderOptions.fontUrls') }}</label>
			<div class="ep-settings-list">
				<div v-for="(url, idx) in local.fontUrls" :key="idx" class="ep-settings-list-item">
					<input
						v-model="local.fontUrls[idx]"
						type="text"
						class="ep-settings-input"
						placeholder="https://fonts.googleapis.com/css2?family=..."
						@change="emitUpdate()"
					/>
					<button class="ep-settings-list-remove" @click="removeFontUrl(idx)">
						<TrashIcon class="ep-settings-list-remove-icon" />
					</button>
				</div>
				<button class="ep-settings-list-add" @click="addFontUrl">
					<PlusIcon class="ep-settings-list-add-icon" />
					{{ t('builder.preview.renderOptions.addFontUrl') }}
				</button>
			</div>
		</div>
	</SettingsAccordion>
</template>

<style scoped src="./fields.css"></style>

<style scoped>
.ep-settings-select {
	padding: 6px 8px;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	color: var(--ep-text-primary);
	font-size: 12px;
	outline: none;
}

.ep-settings-select:focus {
	border-color: var(--ep-brand);
}

.ep-settings-textarea {
	padding: 6px 8px;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	color: var(--ep-text-primary);
	font-size: 12px;
	font-family: var(--ep-font-mono);
	resize: vertical;
	outline: none;
}

.ep-settings-textarea:focus {
	border-color: var(--ep-brand);
}

.ep-settings-list {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.ep-settings-list-item {
	display: flex;
	gap: 6px;
	align-items: center;
}

.ep-settings-list-item .ep-settings-input {
	flex: 1;
}
</style>
