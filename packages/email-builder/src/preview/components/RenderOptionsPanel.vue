<script setup lang="ts">
import { X } from '@lucide/vue';
import type { PreviewRenderOptions } from '../types';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';
import AdvancedOptions from './renderOptions/AdvancedOptions.vue';
import VariableOptions from './renderOptions/VariableOptions.vue';
import { provideRenderOptionsDraft } from './renderOptions/useRenderOptionsDraft';

const { t } = useBuilderI18n();

const props = defineProps<{
	options: Partial<PreviewRenderOptions>;
}>();

const emit = defineEmits<{
	(e: 'update:options', options: Partial<PreviewRenderOptions>): void;
	(e: 'close'): void;
}>();

// The sections below share this draft; every change goes out as one options set.
const { local, emitUpdate } = provideRenderOptionsDraft(
	() => props.options,
	(options) => emit('update:options', options)
);
</script>

<template>
	<div class="ep-settings-panel">
		<div class="ep-settings-header">
			<span class="ep-settings-title">{{ t('builder.preview.renderOptions.title') }}</span>
			<button class="ep-settings-close" @click="emit('close')">
				<X class="ep-settings-close-icon" />
			</button>
		</div>

		<div class="ep-settings-body">
			<!-- Basic Settings -->
			<div class="ep-settings-group">
				<!-- Base Width -->
				<div class="ep-settings-field">
					<label class="ep-settings-label">{{
						t('builder.preview.renderOptions.baseWidth')
					}}</label>
					<input
						v-model.number="local.baseWidth"
						type="number"
						class="ep-settings-input ep-settings-input-number"
						:min="400"
						:max="800"
						:step="10"
						@change="emitUpdate()"
					/>
				</div>

				<!-- Direction -->
				<div class="ep-settings-field">
					<label class="ep-settings-label">{{
						t('builder.preview.renderOptions.direction')
					}}</label>
					<div class="ep-settings-toggle-group">
						<button
							class="ep-settings-toggle"
							:class="{ 'ep-settings-toggle-active': local.direction === 'ltr' }"
							@click="
								local.direction = 'ltr';
								emitUpdate();
							"
						>
							LTR
						</button>
						<button
							class="ep-settings-toggle"
							:class="{ 'ep-settings-toggle-active': local.direction === 'rtl' }"
							@click="
								local.direction = 'rtl';
								emitUpdate();
							"
						>
							RTL
						</button>
					</div>
				</div>

				<!-- Minify -->
				<div class="ep-settings-field ep-settings-field-inline">
					<label class="ep-settings-label">{{ t('builder.preview.renderOptions.minify') }}</label>
					<button
						class="ep-settings-checkbox"
						:class="{ 'ep-settings-checkbox-active': local.minify }"
						@click="
							local.minify = !local.minify;
							emitUpdate();
						"
					>
						<span class="ep-settings-checkbox-dot"></span>
					</button>
				</div>

				<!-- CSS Inlining -->
				<div class="ep-settings-field ep-settings-field-inline">
					<label class="ep-settings-label">{{
						t('builder.preview.renderOptions.inlineCss')
					}}</label>
					<button
						class="ep-settings-checkbox"
						:class="{ 'ep-settings-checkbox-active': local.inlineCss }"
						@click="
							local.inlineCss = !local.inlineCss;
							emitUpdate();
						"
					>
						<span class="ep-settings-checkbox-dot"></span>
					</button>
				</div>
			</div>

			<!-- Advanced Settings (Accordion) -->
			<AdvancedOptions />

			<!-- Variable Values (Accordion) -->
			<VariableOptions />
		</div>
	</div>
</template>

<!-- Field styles shared with the AdvancedOptions and VariableOptions sections. -->
<style scoped src="./renderOptions/fields.css"></style>

<style scoped>
.ep-settings-panel {
	border-bottom: 1px solid var(--ep-border-subtle);
	background: var(--ep-bg-elevated);
}

.ep-settings-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 16px;
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-settings-title {
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-text-primary);
}

.ep-settings-close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	background: transparent;
	border: none;
	border-radius: 4px;
	color: var(--ep-text-tertiary);
	cursor: pointer;
}

.ep-settings-close:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
}

.ep-settings-close-icon {
	width: 14px;
	height: 14px;
}

.ep-settings-body {
	padding: 12px 16px;
	max-height: 400px;
	overflow-y: auto;
}

.ep-settings-group {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding-bottom: 12px;
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-settings-field-inline {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
}

/* Toggle group (LTR/RTL) */
.ep-settings-toggle-group {
	display: flex;
	background: var(--ep-bg-surface);
	border-radius: 6px;
	padding: 2px;
}

.ep-settings-toggle {
	padding: 4px 12px;
	background: transparent;
	border: none;
	border-radius: 4px;
	color: var(--ep-text-tertiary);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	transition-property: color, background-color, box-shadow;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-settings-toggle-active {
	background: var(--ep-bg-elevated);
	color: var(--ep-text-primary);
	box-shadow: var(--ep-shadow-sm);
}

/* Checkbox toggle */
.ep-settings-checkbox {
	width: 32px;
	height: 18px;
	padding: 2px;
	background: var(--ep-bg-overlay);
	border: none;
	border-radius: 9px;
	cursor: pointer;
	transition: background var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-settings-checkbox-active {
	background: var(--ep-brand);
}

.ep-settings-checkbox-dot {
	display: block;
	width: 14px;
	height: 14px;
	background: var(--ep-text-primary);
	border-radius: 50%;
	transition: transform var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-settings-checkbox-active .ep-settings-checkbox-dot {
	transform: translateX(14px);
}
</style>
