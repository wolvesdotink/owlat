<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{ clientId: Id<'mcpClients'> }>();

const { t, locale } = useI18n();

const { data, isLoading, error, refetch } = useConvexQuery(api.mcp.activity.list, () => ({
	clientId: props.clientId,
}));
const rows = computed(() => data.value ?? []);

const TOOL_KEYS = {
	list_mailboxes: 'components.preferences.mcpClientActivity.tools.listMailboxes',
	list_folders: 'components.preferences.mcpClientActivity.tools.listFolders',
	list_labels: 'components.preferences.mcpClientActivity.tools.listLabels',
	search_mail: 'components.preferences.mcpClientActivity.tools.searchMail',
	read_thread: 'components.preferences.mcpClientActivity.tools.readThread',
} as const;

const OUTCOME_KEYS = {
	ok: 'components.preferences.mcpClientActivity.outcomes.ok',
	denied: 'components.preferences.mcpClientActivity.outcomes.denied',
	invalid: 'components.preferences.mcpClientActivity.outcomes.invalid',
	error: 'components.preferences.mcpClientActivity.outcomes.error',
} as const;

function formatTime(ts: number) {
	return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
		ts
	);
}
</script>

<template>
	<div class="rounded border border-border-subtle bg-bg-base">
		<div v-if="isLoading" class="p-4 flex justify-center">
			<Icon
				name="lucide:loader-2"
				class="w-4 h-4 animate-spin motion-reduce:animate-none text-text-tertiary"
			/>
		</div>
		<UiQueryBoundary v-else-if="error" :error="error" @retry="refetch" />
		<p v-else-if="rows.length === 0" class="p-4 text-sm text-text-secondary">
			{{ t('components.preferences.mcpClientActivity.empty') }}
		</p>
		<ul v-else class="divide-y divide-border-subtle text-xs">
			<li
				v-for="row in rows"
				:key="row._id"
				class="px-3 py-2 flex flex-wrap items-baseline gap-x-2"
			>
				<span class="text-text-tertiary tabular-nums">{{ formatTime(row.at) }}</span>
				<span class="font-medium">{{ t(TOOL_KEYS[row.tool]) }}</span>
				<span v-if="row.query" class="font-mono text-text-secondary break-all"
					>“{{ row.query }}”</span
				>
				<span v-if="row.resultCount !== undefined" class="text-text-secondary">{{
					t(
						'components.preferences.mcpClientActivity.results',
						{ count: row.resultCount },
						row.resultCount
					)
				}}</span>
				<span v-if="row.outcome !== 'ok'" class="text-error">{{
					t(OUTCOME_KEYS[row.outcome])
				}}</span>
			</li>
		</ul>
	</div>
</template>
