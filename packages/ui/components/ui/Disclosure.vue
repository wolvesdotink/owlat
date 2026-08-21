<script setup lang="ts">
/** Accessible progressive-disclosure trigger shared across Owlat surfaces. */
import { useUiI18n } from '../../composables/useUiI18n';

// `label` has no default: prop defaults are evaluated outside the setup
// context, where `useUiI18n()` cannot run. It is resolved below instead.
const props = withDefaults(
	defineProps<{
		/** Defaults to the localized "Advanced". */
		label?: string;
		controls?: string;
		disabled?: boolean;
	}>(),
	{ label: undefined, disabled: false }
);

const { t } = useUiI18n();

const resolvedLabel = computed(() => props.label ?? t('ui.disclosure.label'));

const open = defineModel<boolean>({ required: true });
const generatedId = useId();
const contentId = computed(() => props.controls ?? `disclosure-${generatedId}`);
</script>

<template>
	<div>
		<button
			type="button"
			class="text-sm text-text-secondary hover:text-text-primary inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded disabled:opacity-50"
			:aria-expanded="open"
			:aria-controls="contentId"
			:disabled="disabled"
			@click="open = !open"
		>
			<Icon :name="open ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="w-4 h-4" />
			<slot name="label">{{ resolvedLabel }}</slot>
		</button>
		<div v-if="open" :id="contentId" class="mt-3">
			<slot />
		</div>
	</div>
</template>
