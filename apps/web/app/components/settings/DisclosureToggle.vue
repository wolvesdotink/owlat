<script setup lang="ts">
/**
 * A small "Advanced: …" disclosure trigger for the settings pages: a chevron +
 * label button that toggles an `open` model. It announces its state to
 * assistive tech via `aria-expanded` and points at the region it reveals with
 * `aria-controls`, so the revealed block must carry `:id="controls"`.
 */
defineProps<{
	label: string;
	/** The `id` of the region this toggle reveals — bound to `aria-controls`. */
	controls: string;
	disabled?: boolean;
}>();

const open = defineModel<boolean>('open', { required: true });
</script>

<template>
	<button
		type="button"
		class="text-sm text-text-secondary hover:text-text-primary inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded disabled:opacity-50"
		:aria-expanded="open"
		:aria-controls="controls"
		:disabled="disabled"
		@click="open = !open"
	>
		<Icon :name="open ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="w-4 h-4" />
		{{ label }}
	</button>
</template>
