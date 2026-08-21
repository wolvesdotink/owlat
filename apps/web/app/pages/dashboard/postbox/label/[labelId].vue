<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Mail — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const labelId = useRouteId<'mailLabels'>('labelId');
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// Server-side label view: `listByLabel` scans the mailbox's newest messages
// server-side and returns only rows carrying this label. Replaces the P3
// stopgap that fetched up to 500 recent mailbox messages to the browser and
// filtered labelIds client-side. The view's reach is the backend's bounded
// scan window, so "Load more" grows the returned slice rather than paging a
// cursor.
const resetKey = computed(() => `${String(mailboxId.value ?? '')}:${String(labelId.value)}`);
const { limit, loadMore } = useGrowableLimit(resetKey, { page: 100, max: 500 });

const {
	data: labelData,
	isLoading,
	error,
} = useConvexQuery(
	api.mail.mailbox.listByLabel,
	() =>
		mailboxId.value
			? { mailboxId: mailboxId.value, labelId: labelId.value, limit: limit.value }
			: 'skip',
	{ keepPreviousData: true }
);
const labelMessages = computed(() => labelData.value?.messages ?? []);
const hasMore = computed(() => (labelData.value?.hasMore ?? false) && limit.value < 500);

// The label's own row (name + color for the header) — labels are few, so the
// list query is the cheap way to resolve one without a dedicated by-id read.
const { data: labels } = useConvexQuery(api.mail.labels.list, () =>
	mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
);
const label = computed(() => (labels.value ?? []).find((l) => l._id === labelId.value));
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div class="flex w-full">
				<aside class="w-96 border-r border-border-subtle flex flex-col bg-bg-surface">
					<header class="border-b border-border-subtle px-4 py-3 flex items-center gap-2">
						<span
							class="w-2.5 h-2.5 rounded-full flex-shrink-0"
							:style="{ backgroundColor: label?.color || '#6b7280' }"
						/>
						<h2 class="text-sm font-semibold text-text-primary truncate">
							{{ label?.name ?? 'Label view' }}
						</h2>
					</header>
					<PostboxQuickActionsBar :mailbox-id="mailboxId!" />
					<UiErrorAlert
						v-if="error"
						message="Couldn't load messages for this label. Reload to try again."
						class="m-3"
					/>
					<div class="flex-1 overflow-auto">
						<PostboxThreadList
							:mailbox-id="mailboxId!"
							:messages="labelMessages"
							:loading="isLoading"
							folder-role="inbox"
							empty-context="label"
							:has-more="hasMore"
							@load-more="loadMore"
						/>
					</div>
				</aside>
				<section class="flex-1 flex items-center justify-center text-text-secondary">
					Select a message
				</section>
			</div>
		</PostboxMailboxGuard>
		<PostboxComposerStack />
		<PostboxShortcutHelp />
	</div>
</template>
