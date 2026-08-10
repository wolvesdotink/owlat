<script setup lang="ts">
/** Accessible progressive-disclosure trigger shared across Owlat surfaces. */
const props = withDefaults(
	defineProps<{
		label?: string;
		controls?: string;
		disabled?: boolean;
	}>(),
	{ label: 'Advanced', disabled: false }
);

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
			<slot name="label">{{ label }}</slot>
		</button>
		<div v-if="open" :id="contentId" class="mt-3">
			<slot />
		</div>
	</div>
</template>
