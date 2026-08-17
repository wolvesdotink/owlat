<script setup lang="ts">
/**
 * The one back-link every Preferences sub-page opens with.
 *
 * Ten pages carried a byte-identical copy of this block, and the copies had
 * already drifted: nine said "Back to settings" — the name of the section
 * before it became Preferences — one said "Back to Preferences", and one used a
 * slightly larger icon and gap. One component means the label is corrected in
 * one place and the next sub-page cannot reintroduce the old wording.
 *
 * `to` and `label` default to the Preferences hub because that is where all ten
 * pointed; they are props so a page nested one level deeper (a team inbox's
 * members screen, say) can point at its own parent without hand-rolling the
 * block again. The default label is resolved in setup rather than through
 * `withDefaults`, because a prop default is hoisted out of `t()`'s reach.
 */
const props = withDefaults(defineProps<{ to?: string; label?: string }>(), {
	to: '/dashboard/preferences',
	label: undefined,
});

const { t } = useI18n();

const resolvedLabel = computed(
	() => props.label ?? t('components.preferences.preferencesBackLink.label')
);
</script>

<template>
	<NuxtLink
		:to="to"
		class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
	>
		<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
		{{ resolvedLabel }}
	</NuxtLink>
</template>
