<script setup lang="ts">
import { reactive, watch } from 'vue';
import {
	X,
	Plus,
	Trash2,
	ChevronDown,
} from '@lucide/vue';
import type { PreviewRenderOptions } from '../types';

const props = defineProps<{
	options: Partial<PreviewRenderOptions>;
}>();

const emit = defineEmits<{
	(e: 'update:options', options: Partial<PreviewRenderOptions>): void;
	(e: 'close'): void;
}>();

// Local reactive state mirroring props
const local = reactive({
	baseWidth: props.options.baseWidth ?? 600,
	breakpoint: props.options.breakpoint ?? 480,
	direction: props.options.direction ?? 'ltr' as 'ltr' | 'rtl',
	minify: props.options.minify ?? false,
	inlineCss: props.options.inlineCss ?? true,
	validationLevel: props.options.validationLevel ?? 'soft' as string,
	lang: props.options.lang ?? 'en',
	customCss: props.options.customCss ?? '',
	fontUrls: [...(props.options.fontUrls ?? [])],
	preheaderText: props.options.preheaderText ?? '',
	title: props.options.title ?? '',
	variableValues: Object.entries(props.options.variableValues ?? {}).map(([key, value]) => ({ key, value })),
});

const advancedExpanded = reactive({ value: false });
const variablesExpanded = reactive({ value: false });

// Emit on every change
function emitUpdate() {
	const opts: Partial<PreviewRenderOptions> = {
		baseWidth: local.baseWidth,
		breakpoint: local.breakpoint,
		direction: local.direction,
		minify: local.minify,
		inlineCss: local.inlineCss,
		validationLevel: local.validationLevel as PreviewRenderOptions['validationLevel'],
		lang: local.lang,
		customCss: local.customCss || undefined,
		fontUrls: local.fontUrls.filter(Boolean).length > 0 ? local.fontUrls.filter(Boolean) : undefined,
		preheaderText: local.preheaderText || undefined,
		title: local.title || undefined,
		variableValues: local.variableValues.length > 0
			? Object.fromEntries(local.variableValues.filter((v) => v.key).map((v) => [v.key, v.value]))
			: undefined,
	};
	emit('update:options', opts);
}

function addFontUrl() {
	local.fontUrls.push('');
}

function removeFontUrl(index: number) {
	local.fontUrls.splice(index, 1);
	emitUpdate();
}

function addVariable() {
	local.variableValues.push({ key: '', value: '' });
}

function removeVariable(index: number) {
	local.variableValues.splice(index, 1);
	emitUpdate();
}

// Sync props changes to local state
watch(() => props.options, (newOpts) => {
	if (newOpts.baseWidth !== undefined) local.baseWidth = newOpts.baseWidth;
	if (newOpts.direction !== undefined) local.direction = newOpts.direction;
	if (newOpts.minify !== undefined) local.minify = newOpts.minify;
}, { deep: true });
</script>

<template>
	<div class="ep-settings-panel">
		<div class="ep-settings-header">
			<span class="ep-settings-title">Render Options</span>
			<button class="ep-settings-close" @click="emit('close')">
				<X class="ep-settings-close-icon" />
			</button>
		</div>

		<div class="ep-settings-body">
			<!-- Basic Settings -->
			<div class="ep-settings-group">
				<!-- Base Width -->
				<div class="ep-settings-field">
					<label class="ep-settings-label">Base Width (px)</label>
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
					<label class="ep-settings-label">Direction</label>
					<div class="ep-settings-toggle-group">
						<button
							class="ep-settings-toggle"
							:class="{ 'ep-settings-toggle-active': local.direction === 'ltr' }"
							@click="local.direction = 'ltr'; emitUpdate()"
						>
							LTR
						</button>
						<button
							class="ep-settings-toggle"
							:class="{ 'ep-settings-toggle-active': local.direction === 'rtl' }"
							@click="local.direction = 'rtl'; emitUpdate()"
						>
							RTL
						</button>
					</div>
				</div>

				<!-- Minify -->
				<div class="ep-settings-field ep-settings-field-inline">
					<label class="ep-settings-label">Minify HTML</label>
					<button
						class="ep-settings-checkbox"
						:class="{ 'ep-settings-checkbox-active': local.minify }"
						@click="local.minify = !local.minify; emitUpdate()"
					>
						<span class="ep-settings-checkbox-dot"></span>
					</button>
				</div>

				<!-- CSS Inlining -->
				<div class="ep-settings-field ep-settings-field-inline">
					<label class="ep-settings-label">Inline CSS</label>
					<button
						class="ep-settings-checkbox"
						:class="{ 'ep-settings-checkbox-active': local.inlineCss }"
						@click="local.inlineCss = !local.inlineCss; emitUpdate()"
					>
						<span class="ep-settings-checkbox-dot"></span>
					</button>
				</div>
			</div>

			<!-- Advanced Settings (Accordion) -->
			<div class="ep-settings-accordion">
				<button
					class="ep-settings-accordion-header"
					@click="advancedExpanded.value = !advancedExpanded.value"
				>
					<span>Advanced Settings</span>
					<ChevronDown
						class="ep-settings-accordion-chevron"
						:class="{ 'ep-settings-accordion-open': advancedExpanded.value }"
					/>
				</button>
				<div v-if="advancedExpanded.value" class="ep-settings-accordion-body">
					<!-- Breakpoint -->
					<div class="ep-settings-field">
						<label class="ep-settings-label">Breakpoint (px)</label>
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
						<label class="ep-settings-label">Language</label>
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
						<label class="ep-settings-label">Validation Level</label>
						<select
							v-model="local.validationLevel"
							class="ep-settings-select"
							@change="emitUpdate()"
						>
							<option value="skip">Skip</option>
							<option value="soft">Soft</option>
							<option value="strict">Strict</option>
						</select>
					</div>

					<!-- Title -->
					<div class="ep-settings-field">
						<label class="ep-settings-label">Title</label>
						<input
							v-model="local.title"
							type="text"
							class="ep-settings-input"
							placeholder="Email title"
							@change="emitUpdate()"
						/>
					</div>

					<!-- Preheader Text -->
					<div class="ep-settings-field">
						<label class="ep-settings-label">Preheader Text</label>
						<input
							v-model="local.preheaderText"
							type="text"
							class="ep-settings-input"
							placeholder="Hidden preview text..."
							@change="emitUpdate()"
						/>
					</div>

					<!-- Custom CSS -->
					<div class="ep-settings-field">
						<label class="ep-settings-label">Custom CSS</label>
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
						<label class="ep-settings-label">Font URLs</label>
						<div class="ep-settings-list">
							<div
								v-for="(url, idx) in local.fontUrls"
								:key="idx"
								class="ep-settings-list-item"
							>
								<input
									v-model="local.fontUrls[idx]"
									type="text"
									class="ep-settings-input"
									placeholder="https://fonts.googleapis.com/css2?family=..."
									@change="emitUpdate()"
								/>
								<button class="ep-settings-list-remove" @click="removeFontUrl(idx)">
									<Trash2 class="ep-settings-list-remove-icon" />
								</button>
							</div>
							<button class="ep-settings-list-add" @click="addFontUrl">
								<Plus class="ep-settings-list-add-icon" />
								Add Font URL
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- Variable Values (Accordion) -->
			<div class="ep-settings-accordion">
				<button
					class="ep-settings-accordion-header"
					@click="variablesExpanded.value = !variablesExpanded.value"
				>
					<span>
						Variable Values
						<span v-if="local.variableValues.length > 0" class="ep-settings-accordion-count">
							{{ local.variableValues.length }}
						</span>
					</span>
					<ChevronDown
						class="ep-settings-accordion-chevron"
						:class="{ 'ep-settings-accordion-open': variablesExpanded.value }"
					/>
				</button>
				<div v-if="variablesExpanded.value" class="ep-settings-accordion-body">
					<div
						v-for="(variable, idx) in local.variableValues"
						:key="idx"
						class="ep-settings-kv-row"
					>
						<input
							v-model="variable.key"
							type="text"
							class="ep-settings-input ep-settings-kv-key"
							placeholder="Variable name"
							@change="emitUpdate()"
						/>
						<input
							v-model="variable.value"
							type="text"
							class="ep-settings-input ep-settings-kv-value"
							placeholder="Value"
							@change="emitUpdate()"
						/>
						<button class="ep-settings-list-remove" @click="removeVariable(idx)">
							<Trash2 class="ep-settings-list-remove-icon" />
						</button>
					</div>
					<button class="ep-settings-list-add" @click="addVariable">
						<Plus class="ep-settings-list-add-icon" />
						Add Variable
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

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

.ep-settings-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.ep-settings-field-inline {
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
}

.ep-settings-label {
	font-size: 11px;
	font-weight: 500;
	color: var(--ep-text-secondary);
}

.ep-settings-input {
	padding: 6px 8px;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	color: var(--ep-text-primary);
	font-size: 12px;
	font-family: inherit;
	outline: none;
	transition: border-color var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-settings-input:focus {
	border-color: var(--ep-brand);
}

.ep-settings-input-number {
	width: 80px;
}

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
	transition: all var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
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

/* Accordion */
.ep-settings-accordion {
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-settings-accordion:first-of-type {
	margin-top: 12px;
}

.ep-settings-accordion-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	width: 100%;
	padding: 10px 0;
	background: transparent;
	border: none;
	color: var(--ep-text-secondary);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
}

.ep-settings-accordion-header:hover {
	color: var(--ep-text-primary);
}

.ep-settings-accordion-count {
	padding: 0 5px;
	background: var(--ep-bg-surface);
	border-radius: 8px;
	font-size: 10px;
	color: var(--ep-text-tertiary);
}

.ep-settings-accordion-chevron {
	width: 14px;
	height: 14px;
	color: var(--ep-text-tertiary);
	transition: transform var(--motion-moderate, 160ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-settings-accordion-open {
	transform: rotate(180deg);
}

.ep-settings-accordion-body {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding-bottom: 12px;
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

/* List items (font URLs, variables) */
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

.ep-settings-list-remove {
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
	flex-shrink: 0;
}

.ep-settings-list-remove:hover {
	background: var(--ep-error-subtle);
	color: var(--ep-error);
}

.ep-settings-list-remove-icon {
	width: 12px;
	height: 12px;
}

.ep-settings-list-add {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 0;
	background: transparent;
	border: none;
	color: var(--ep-brand);
	font-size: 11px;
	cursor: pointer;
}

.ep-settings-list-add:hover {
	color: var(--ep-brand-hover);
}

.ep-settings-list-add-icon {
	width: 12px;
	height: 12px;
}
</style>
