<script setup lang="ts">
/**
 * The state of a switched-on filter whose mailbox's new mail never reaches it
 * (a connected mailbox). Only "Run on existing mail" applies it, and a run
 * applies nothing for a filter with no action the sweep performs.
 */
import { hasRetroactiveActions, type FilterAction } from '~/composables/postbox/usePostboxFilters';

const props = defineProps<{ actions: FilterAction[] }>();

const { t } = useI18n();
</script>

<template>
	<UiBadge variant="warning" data-testid="filter-runs-on-apply">
		{{
			hasRetroactiveActions(props.actions)
				? t('dashboard.preferences.filters.runsOnApply')
				: t('dashboard.preferences.filters.neverRuns')
		}}
	</UiBadge>
</template>
