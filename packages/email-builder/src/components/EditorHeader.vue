<script setup lang="ts">
import { computed } from 'vue';
import {
	ArrowLeft,
	Save,
	Loader2,
	Eye,
	Code2,
	Maximize2,
	Minimize2,
	Undo2,
	Redo2,
	Settings,
	Keyboard,
} from '@lucide/vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import type { PreviewMode, EmailBuilderConfig } from '../types';
import { findShortcut, formatShortcut } from '../composables/editorShortcuts';

const props = defineProps<{
	name: string;
	subject: string;
	previewMode: PreviewMode;
	isFocusMode: boolean;
	isSaving: boolean;
	isGeneratingHtml: boolean;
	hideSubject: boolean;
	config?: EmailBuilderConfig;
	canUndo?: boolean;
	canRedo?: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:name', value: string): void;
	(e: 'update:subject', value: string): void;
	(e: 'toggle-preview'): void;
	(e: 'toggle-focus-mode'): void;
	(e: 'save'): void;
	(e: 'back'): void;
	(e: 'undo'): void;
	(e: 'redo'): void;
	(e: 'settings'): void;
	(e: 'show-shortcuts'): void;
}>();

const previewModeOptions = computed(() => [
	{ value: 'edit', label: 'Edit' },
	{ value: 'preview', label: 'Preview', disabled: props.isGeneratingHtml },
]);

// Tooltips read from the shortcut registry so they can never drift from the
// bindings or from the help sheet. The fallback keys only apply if an entry is
// ever renamed out of the registry, so the tooltip degrades instead of vanishing.
function shortcutTitle(description: string, fallbackKeys: string[]): string {
	return `${description} (${formatShortcut(findShortcut(description)?.keys ?? fallbackKeys)})`;
}

const undoTitle = computed(() => shortcutTitle('Undo', ['Mod', 'Z']));
const redoTitle = computed(() => shortcutTitle('Redo', ['Mod', 'Shift', 'Z']));
</script>

<template>
	<div
		class="shrink-0 h-14 border-b border-border-subtle bg-bg-base flex items-center justify-between px-4"
		style="box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15)"
	>
		<div class="flex items-center gap-4">
			<UiButton
				variant="ghost"
				class="!px-2 !py-2"
				title="Back"
				aria-label="Back"
				@click="emit('back')"
			>
				<ArrowLeft class="w-5 h-5" aria-hidden="true" />
			</UiButton>

			<div class="flex flex-col">
				<input
					:value="name"
					type="text"
					:aria-label="config?.mode === 'block' ? 'Block name' : 'Template name'"
					class="bg-transparent text-text-primary font-medium text-sm focus:outline-none border-b border-transparent hover:border-border-strong focus:border-brand transition-colors px-1 -mx-1"
					:placeholder="config?.mode === 'block' ? 'Block name' : 'Template name'"
					@input="emit('update:name', ($event.target as HTMLInputElement).value)"
				/>
				<input
					v-if="!hideSubject"
					:value="subject"
					type="text"
					aria-label="Email subject line"
					class="bg-transparent text-text-secondary text-xs focus:outline-none border-b border-transparent hover:border-border-strong focus:border-brand transition-colors px-1 -mx-1 mt-0.5"
					placeholder="Email subject line"
					@input="emit('update:subject', ($event.target as HTMLInputElement).value)"
				/>
			</div>
		</div>

		<div class="flex items-center gap-3">
			<!-- Preview Mode Toggle -->
			<UiSegmentedControl
				:model-value="previewMode"
				:options="previewModeOptions"
				@update:model-value="emit('toggle-preview')"
			>
				<template #option-edit>
					<Code2 class="w-4 h-4" />
					Edit
				</template>
				<template #option-preview>
					<Loader2 v-if="isGeneratingHtml" class="w-4 h-4 animate-spin" />
					<Eye v-else class="w-4 h-4" />
					Preview
				</template>
			</UiSegmentedControl>

			<!-- Focus Mode Toggle -->
			<UiButton
				:variant="isFocusMode ? 'primary' : 'ghost'"
				class="!px-2 !py-2"
				:title="isFocusMode ? 'Exit focus mode' : 'Enter focus mode'"
				:aria-label="isFocusMode ? 'Exit focus mode' : 'Enter focus mode'"
				:aria-pressed="isFocusMode"
				@click="emit('toggle-focus-mode')"
			>
				<Minimize2 v-if="isFocusMode" class="w-4 h-4" />
				<Maximize2 v-else class="w-4 h-4" />
			</UiButton>

			<!-- Undo/Redo Buttons -->
			<div class="flex items-center gap-1">
				<UiButton
					variant="ghost"
					class="!px-2 !py-2"
					:disabled="!canUndo"
					:title="undoTitle"
					:aria-label="undoTitle"
					@click="emit('undo')"
				>
					<Undo2 class="w-4 h-4" />
				</UiButton>
				<UiButton
					variant="ghost"
					class="!px-2 !py-2"
					:disabled="!canRedo"
					:title="redoTitle"
					:aria-label="redoTitle"
					@click="emit('redo')"
				>
					<Redo2 class="w-4 h-4" />
				</UiButton>
			</div>

			<!-- Keyboard shortcuts help -->
			<UiButton
				variant="ghost"
				class="!px-2 !py-2"
				title="Keyboard shortcuts (?)"
				aria-label="Keyboard shortcuts"
				@click="emit('show-shortcuts')"
			>
				<Keyboard class="w-4 h-4" />
			</UiButton>

			<div class="w-px h-6 bg-border-default" />

			<!-- Toolbar actions slot -->
			<slot name="toolbar-actions" />

			<!-- Settings Button -->
			<UiButton
				v-if="config?.showSettings"
				variant="ghost"
				class="!px-2 !py-2"
				:title="config?.mode === 'block' ? 'Block settings' : 'Template settings'"
				:aria-label="config?.mode === 'block' ? 'Block settings' : 'Template settings'"
				@click="emit('settings')"
			>
				<Settings class="w-4 h-4" />
			</UiButton>

			<!-- Save Button -->
			<UiButton variant="primary" size="sm" :disabled="isSaving" @click="emit('save')">
				<Loader2 v-if="isSaving" class="w-4 h-4 animate-spin" />
				<Save v-else class="w-4 h-4" />
				{{ isSaving ? 'Saving...' : 'Save' }}
			</UiButton>
		</div>
	</div>
</template>
