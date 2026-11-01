<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import { computed } from 'vue';
import {
	ArrowLeftIcon,
	CodeIcon,
	ExpandIcon,
	EyeIcon,
	KeyboardIcon,
	PaletteIcon,
	RedoIcon,
	SaveIcon,
	SettingsIcon,
	ShrinkIcon,
	UndoIcon,
} from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import type { PreviewMode, EmailBuilderConfig } from '../types';
import { findShortcut, formatShortcut, useApplePlatform } from '../composables/editorShortcuts';
import { useBuilderI18n } from '../i18n/useBuilderI18n';

const { t, label } = useBuilderI18n();

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
	/** Offer "Apply brand kit" (the organization has saved one). */
	canApplyBrand?: boolean;
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
	(e: 'apply-brand'): void;
}>();

const previewModeOptions = computed(() => [
	{ value: 'edit', label: t('builder.header.edit') },
	{ value: 'preview', label: t('builder.header.preview'), disabled: props.isGeneratingHtml },
]);

// Tooltips read from the shortcut registry so they can never drift from the
// bindings or from the help sheet. The fallback keys only apply if an entry is
// ever renamed out of the registry, so the tooltip degrades instead of vanishing.
// The registry's English description is the lookup id; what is shown is its
// translation.
// The modifier symbol comes from a post-mount ref, so the server and the first
// client render agree on the markup.
const isApplePlatform = useApplePlatform();

function shortcutTitle(description: string, fallbackKeys: string[]): string {
	const keys = formatShortcut(
		findShortcut(description)?.keys ?? fallbackKeys,
		isApplePlatform.value
	)
		.split(' + ')
		.map((key) => label(key))
		.join(' + ');
	return `${label(description)} (${keys})`;
}

const nameLabel = computed(() =>
	props.config?.mode === 'block' ? t('builder.header.blockName') : t('builder.header.templateName')
);
const settingsLabel = computed(() =>
	props.config?.mode === 'block'
		? t('builder.header.blockSettings')
		: t('builder.header.templateSettings')
);
const focusModeLabel = computed(() =>
	props.isFocusMode ? t('builder.header.exitFocus') : t('builder.header.enterFocus')
);
const undoTitle = computed(() => shortcutTitle('Undo', ['Mod', 'Z']));
const redoTitle = computed(() => shortcutTitle('Redo', ['Mod', 'Shift', 'Z']));
</script>

<template>
	<!--
		The left cluster (back + name) gives way first: its inputs truncate so the
		right cluster, whose Save must stay reachable, keeps its natural width.
	-->
	<div
		class="shrink-0 h-14 border-b border-border-subtle bg-bg-base flex items-center justify-between gap-3 px-4"
		style="box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15)"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2 lg:gap-4">
			<UiTooltip :text="t('builder.header.back')">
				<UiButton
					variant="ghost"
					class="!px-2 !py-2"
					:aria-label="t('builder.header.back')"
					@click="emit('back')"
				>
					<ArrowLeftIcon class="w-5 h-5" aria-hidden="true" />
				</UiButton>
			</UiTooltip>

			<div class="flex min-w-0 flex-1 flex-col">
				<input
					:value="name"
					type="text"
					:aria-label="nameLabel"
					class="w-full min-w-0 truncate bg-transparent text-text-primary font-medium text-sm focus:outline-none border-b border-transparent hover:border-border-strong focus:border-brand transition-colors px-1 -mx-1"
					:placeholder="nameLabel"
					@input="emit('update:name', ($event.target as HTMLInputElement).value)"
				/>
				<input
					v-if="!hideSubject"
					:value="subject"
					type="text"
					:aria-label="t('builder.header.subject')"
					class="w-full min-w-0 truncate bg-transparent text-text-secondary text-xs focus:outline-none border-b border-transparent hover:border-border-strong focus:border-brand transition-colors px-1 -mx-1 mt-0.5"
					:placeholder="t('builder.header.subject')"
					@input="emit('update:subject', ($event.target as HTMLInputElement).value)"
				/>
			</div>
		</div>

		<div class="flex shrink-0 items-center gap-2 xl:gap-3">
			<!-- Preview Mode Toggle -->
			<UiSegmentedControl
				:model-value="previewMode"
				:options="previewModeOptions"
				@update:model-value="emit('toggle-preview')"
			>
				<template #option-edit>
					<CodeIcon class="w-4 h-4" />
					{{ t('builder.header.edit') }}
				</template>
				<template #option-preview>
					<SpinnerIcon v-if="isGeneratingHtml" class="w-4 h-4" />
					<EyeIcon v-else class="w-4 h-4" />
					{{ t('builder.header.preview') }}
				</template>
			</UiSegmentedControl>

			<!-- Focus Mode Toggle -->
			<UiTooltip :text="focusModeLabel">
				<UiButton
					:variant="isFocusMode ? 'primary' : 'ghost'"
					class="!px-2 !py-2"
					:aria-label="focusModeLabel"
					:aria-pressed="isFocusMode"
					@click="emit('toggle-focus-mode')"
				>
					<ShrinkIcon v-if="isFocusMode" class="w-4 h-4" />
					<ExpandIcon v-else class="w-4 h-4" />
				</UiButton>
			</UiTooltip>

			<!-- Undo/Redo Buttons -->
			<div class="flex items-center gap-1">
				<UiTooltip :text="undoTitle">
					<UiButton
						variant="ghost"
						class="!px-2 !py-2"
						:disabled="!canUndo"
						:aria-label="undoTitle"
						@click="emit('undo')"
					>
						<UndoIcon class="w-4 h-4" />
					</UiButton>
				</UiTooltip>
				<UiTooltip :text="redoTitle">
					<UiButton
						variant="ghost"
						class="!px-2 !py-2"
						:disabled="!canRedo"
						:aria-label="redoTitle"
						@click="emit('redo')"
					>
						<RedoIcon class="w-4 h-4" />
					</UiButton>
				</UiTooltip>
			</div>

			<!-- Keyboard shortcuts help. Tablets (below lg) rarely have a keyboard,
			     and the slot is short of room there; `?` still opens the sheet. -->
			<UiTooltip :text="t('builder.header.shortcutsTitle')">
				<UiButton
					variant="ghost"
					class="!px-2 !py-2 max-lg:!hidden"
					:aria-label="t('builder.header.shortcuts')"
					@click="emit('show-shortcuts')"
				>
					<KeyboardIcon class="w-4 h-4" />
				</UiButton>
			</UiTooltip>

			<!-- Restyle the email with the brand kit (confirmed, undoable) -->
			<UiTooltip v-if="canApplyBrand" :text="t('builder.header.applyBrand')">
				<UiButton
					variant="ghost"
					class="!px-2 !py-2"
					:aria-label="t('builder.header.applyBrand')"
					data-testid="apply-brand-kit"
					@click="emit('apply-brand')"
				>
					<PaletteIcon class="w-4 h-4" />
				</UiButton>
			</UiTooltip>

			<div class="w-px h-6 bg-border-default" />

			<!-- Toolbar actions slot -->
			<slot name="toolbar-actions" />

			<!-- Settings Button -->
			<UiTooltip v-if="config?.showSettings" :text="settingsLabel">
				<UiButton
					variant="ghost"
					class="!px-2 !py-2"
					:aria-label="settingsLabel"
					@click="emit('settings')"
				>
					<SettingsIcon class="w-4 h-4" />
				</UiButton>
			</UiTooltip>

			<!-- Save Button, or the host's save status where it saves on its own -->
			<slot name="save-status">
				<UiButton variant="primary" size="sm" :disabled="isSaving" @click="emit('save')">
					<SpinnerIcon v-if="isSaving" class="w-4 h-4" />
					<SaveIcon v-else class="w-4 h-4" />
					{{ isSaving ? t('builder.header.saving') : t('builder.header.save') }}
				</UiButton>
			</slot>
		</div>
	</div>
</template>
