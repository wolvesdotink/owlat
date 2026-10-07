<script setup lang="ts">
/**
 * "Open threads on: Overview / Conversation" (SPEC §7): where a personal
 * Postbox thread opens. Saved through the self-scoped thread view preference
 * (mail/interpret/preferences.ts), which also works on an install without a
 * Postbox. A per-thread choice made with the reader's switch still wins for
 * that thread, and a link to a cited quote always opens the conversation.
 */
import type { ThreadView } from '@owlat/shared/threadBrief';
import { interpretApi } from '~/composables/threadBrief/briefApi';

const { t } = useI18n();

const { data } = useConvexQuery(interpretApi.preferences.getViewPreference, {});
const current = computed<ThreadView>(() => data.value?.threadDefaultView ?? 'overview');

const save = useBackendOperation(interpretApi.preferences.setThreadDefaultView, {
	label: () => t('components.preferences.preferencesReading.threadViewOperation'),
});

const OPTIONS: { value: ThreadView; key: string }[] = [
	{ value: 'overview', key: 'components.brief.view.overview' },
	{
		value: 'conversation',
		key: 'components.preferences.preferencesReading.threadViewConversation',
	},
];

function onChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value;
	if (value === 'overview' || value === 'conversation') void save.run({ view: value });
}
</script>

<template>
	<div
		class="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 border-t border-border-subtle"
	>
		<div class="min-w-0">
			<label for="postbox-thread-view" class="font-medium text-sm block">
				{{ t('components.preferences.preferencesReading.threadViewLabel') }}
			</label>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{ t('components.preferences.preferencesReading.threadViewHelp') }}
			</p>
		</div>
		<select
			id="postbox-thread-view"
			class="input w-full sm:w-64 shrink-0"
			:value="current"
			:disabled="save.isLoading.value"
			@change="onChange"
		>
			<option v-for="option in OPTIONS" :key="option.value" :value="option.value">
				{{ t(option.key) }}
			</option>
		</select>
	</div>
</template>
