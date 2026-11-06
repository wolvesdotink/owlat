<script setup lang="ts">
/**
 * An AI client's write waiting for the member, wherever they are in the app:
 * the newest one as an approval card, bottom right. The AI clients page lists
 * them all, so the card stays off that page. The card carries the HTML
 * sanitizer for its preview, so it loads only when there is something to approve.
 */
const { t } = useI18n();
const route = useRoute();
const { pending, busyId, notices, approve, reject } = useMcpPendingActions();

const APPROVALS_PATH = '/dashboard/preferences/ai-clients';

const current = computed(() => pending.value[0] ?? null);
const isShown = computed(() => current.value !== null && route.path !== APPROVALS_PATH);

function approveCurrent(reviewDigest: string) {
	if (current.value) void approve(current.value._id, reviewDigest);
}
</script>

<template>
	<aside
		v-if="isShown && current"
		class="fixed bottom-4 right-4 z-40 max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto shadow-2xl"
		:aria-label="t('components.shell.mcpApprovalPrompt.label')"
	>
		<div
			class="flex items-center justify-between gap-3 rounded-t-md border border-b-0 border-border-subtle bg-bg-surface px-4 py-2 text-xs text-text-secondary"
		>
			<span>{{ t('components.shell.mcpApprovalPrompt.waiting', pending.length) }}</span>
			<NuxtLink :to="`${APPROVALS_PATH}#approvals`" class="font-medium text-text-primary">
				{{ t('components.shell.mcpApprovalPrompt.seeAll') }}
			</NuxtLink>
		</div>
		<LazyPreferencesMcpPendingActionCard
			:key="current._id"
			:action="current"
			:busy="busyId === current._id"
			:notice="notices[current._id]"
			class="!rounded-t-none"
			@approve="approveCurrent"
			@reject="reject(current._id)"
		/>
	</aside>
</template>
