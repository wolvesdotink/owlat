<script setup lang="ts">
/**
 * Bespoke tri-state switch for the admin features page. The puck
 * packages/ui Switch.vue draws is two-state; feature packs need "partial",
 * so this stays hand-rolled and is shared by the pack and flag rows.
 */
const props = defineProps<{
	state: 'on' | 'off' | 'partial';
	/** Human label — rendered as `Toggle <label>` for assistive tech. */
	label: string;
	disabled?: boolean;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
	<button
		type="button"
		role="switch"
		:aria-checked="props.state === 'on'"
		:aria-label="`Toggle ${props.label}`"
		class="relative inline-flex shrink-0 h-6 w-11 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 disabled:cursor-not-allowed"
		:class="
			props.state === 'on'
				? 'bg-brand border-brand'
				: props.state === 'partial'
					? 'bg-warning/60 border-warning/60'
					: 'bg-bg-surface border-border-subtle'
		"
		:disabled="props.disabled"
		@click="$emit('toggle')"
	>
		<!-- palette-ok: fixed white thumb on a brand/warning/surface track (the puck packages/ui Switch.vue draws; this tri-state toggle stays bespoke). -->
		<span
			class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform"
			:class="
				props.state === 'on'
					? 'translate-x-[22px]'
					: props.state === 'partial'
						? 'translate-x-[11px]'
						: 'translate-x-0.5'
			"
		/>
	</button>
</template>
