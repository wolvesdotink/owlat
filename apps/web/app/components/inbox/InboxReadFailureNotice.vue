<script setup lang="ts">
/**
 * A list merged from one read per inbox, where some of the reads failed: the
 * rows that loaded stay on screen and this names the sources missing from
 * them, with Try again (#1099). A list with no rows at all shows the full
 * error state instead (#721).
 */
const props = defineProps<{
	/** The failed sources, already localized ("Sales", "Team inbox"). */
	names: readonly string[];
}>();

defineEmits<{
	/** Try again: re-read the failed sources. */
	retry: [];
}>();

const { t, locale } = useI18n();

const nameList = computed(() =>
	new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(props.names)
);
</script>

<template>
	<div
		role="status"
		class="flex items-center gap-3 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2"
		data-testid="inbox-read-failure-notice"
	>
		<Icon name="lucide:alert-triangle" class="size-4 shrink-0 text-warning" aria-hidden="true" />
		<p class="min-w-0 flex-1 text-sm text-text-primary">
			{{ t('components.inbox.readFailureNotice.message', { names: nameList }) }}
		</p>
		<UiButton variant="secondary" size="sm" class="shrink-0" @click="$emit('retry')">
			<template #iconLeft><Icon name="lucide:refresh-cw" class="size-4" /></template>
			{{ t('common.tryAgain') }}
		</UiButton>
	</div>
</template>
