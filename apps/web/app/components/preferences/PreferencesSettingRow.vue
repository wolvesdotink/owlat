<script setup lang="ts">
/**
 * One row of a Preferences card: the label and help on the left, the control
 * on the right, and the "changed from default" marker beside the label.
 *
 * `select` rows stack below `sm` (a 16rem select beside a sentence leaves the
 * sentence no room); `switch` rows stay side by side, a switch is narrow.
 * The `help` slot replaces the plain help line for copy that carries markup.
 */
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';
withDefaults(
	defineProps<{
		/** The control's `id`, which the label points at. */
		controlId: string;
		label: string;
		help?: string;
		layout?: 'select' | 'switch';
		/** The value differs from its default. */
		changed: boolean;
		disabled?: boolean;
		/** The first row of a card has no divider above it. */
		first?: boolean;
	}>(),
	{ help: undefined, layout: 'select', disabled: false, first: false }
);

const emit = defineEmits<{ reset: [] }>();
</script>

<template>
	<div
		class="px-5 py-4 flex"
		:class="[
			layout === 'select'
				? 'flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4'
				: 'items-center justify-between gap-4',
			first ? undefined : 'border-t border-border-subtle',
		]"
	>
		<div class="min-w-0">
			<div class="flex items-center gap-2">
				<label :for="controlId" class="font-medium text-sm block">{{ label }}</label>
				<SettingsResetToDefault
					:changed="changed"
					:label="label"
					:disabled="disabled"
					@reset="emit('reset')"
				/>
			</div>
			<slot name="help">
				<p v-if="help" class="text-xs text-text-tertiary mt-0.5">{{ help }}</p>
			</slot>
		</div>
		<slot />
	</div>
</template>
