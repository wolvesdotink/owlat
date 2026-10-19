<script setup lang="ts">
/**
 * The identity-accent swatches of one desktop workspace (Preferences → This
 * device): a label and one round button per curated accent.
 *
 * Each button is the hit area and the dot inside it is the colour, so the two
 * can differ in size. With a mouse they are the same 20px; on touch
 * (`pointer-coarse`) the button grows to the 44px target the `.btn` recipe uses
 * while the dot stays 20px. The gap then narrows to 2px (the boxes' own
 * padding already spaces the dots) so six targets still fit a phone-width card,
 * and the row wraps instead of letting a target shrink. Real boxes side by side, never an invisible overlay reaching into a
 * neighbour.
 */
import { WORKSPACE_ACCENT_OPTIONS, type WorkspaceAccent } from '~/lib/desktop/workspaceTypes';

defineProps<{
	/** The workspace's current accent. */
	modelValue: WorkspaceAccent;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', accent: WorkspaceAccent): void;
}>();

const { t } = useI18n();
</script>

<template>
	<div class="flex items-center gap-1.5 pointer-coarse:flex-wrap pointer-coarse:gap-0.5">
		<span class="mr-1 text-xs text-text-secondary">{{
			t('desktop.settings.workspaces.accent')
		}}</span>
		<button
			v-for="option in WORKSPACE_ACCENT_OPTIONS"
			:key="option.value"
			type="button"
			class="group/swatch flex size-5 shrink-0 items-center justify-center rounded-full pointer-coarse:size-11"
			:title="t(option.label)"
			:aria-label="t('desktop.settings.workspaces.accentOption', { accent: t(option.label) })"
			:aria-pressed="modelValue === option.value"
			data-testid="workspace-swatch"
			@click="emit('update:modelValue', option.value)"
		>
			<span
				class="size-5 shrink-0 rounded-full border-2 transition-transform group-hover/swatch:scale-110"
				:class="modelValue === option.value ? 'border-text-primary' : 'border-transparent'"
				:style="{ backgroundColor: option.value }"
			/>
		</button>
	</div>
</template>
