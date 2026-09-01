<script setup lang="ts">
/**
 * Bespoke tri-state switch for the admin features page. The puck
 * packages/ui Switch.vue draws is two-state; feature packs need "partial",
 * so this stays hand-rolled and is shared by the pack and flag rows.
 */
const props = defineProps<{
	state: 'on' | 'off' | 'partial';
	/**
	 * Human label, already localized by the caller (the registry's English is
	 * resolved through `useFeatureCopy`) — announced as "Toggle <label>".
	 */
	label: string;
	disabled?: boolean;
}>();

defineEmits<{ toggle: [] }>();

// The features page is this switch's only surface, so it borrows that page's
// accessible-name phrasing rather than minting a second copy of it.
const { t } = useI18n();
</script>

<template>
	<button
		type="button"
		role="switch"
		:aria-checked="props.state === 'on'"
		:aria-label="t('dashboard.admin.instance.features.toggleAria', { label: props.label })"
		class="relative inline-flex shrink-0 h-6 w-11 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 disabled:cursor-not-allowed"
		:class="
			props.state === 'on'
				? 'bg-text-primary border-text-primary'
				: props.state === 'partial'
					? 'bg-warning/60 border-warning/60'
					: 'bg-bg-surface border-border-subtle'
		"
		:disabled="props.disabled"
		@click="$emit('toggle')"
	>
		<!-- palette-ok: fixed white thumb on the warning/surface tracks (the puck
		     packages/ui Switch.vue draws; this tri-state toggle stays bespoke). The
		     ON track is the .btn-primary fill — near-black in light, near-white in
		     dark — because the features page shows THIRTY of these at once and a
		     terracotta fill thirty times over is the opposite of one accent per
		     screen. Its thumb takes the paired `text-inverse` so it contrasts in
		     both themes; terracotta stays on the focus ring. -->
		<span
			class="inline-block h-5 w-5 transform rounded-full transition-transform"
			:class="[
				props.state === 'on' ? 'bg-text-inverse' : 'bg-white',
				props.state === 'on'
					? 'translate-x-[22px]'
					: props.state === 'partial'
						? 'translate-x-[11px]'
						: 'translate-x-0.5',
			]"
		/>
	</button>
</template>
