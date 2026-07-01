<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Mail — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
const labelId = computed(() => String(route.params['labelId'] ?? '') as Id<'mailLabels'>);
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// Fetch all messages and filter by label client-side. P7 will replace this
// with a server-side query/index. For P3 the volume is small enough to keep
// the implementation lean.
const { data: allMessages, isLoading, error } = useConvexQuery(
	api.mail.mailbox.listMessages,
	() => (mailboxId.value ? { mailboxId: mailboxId.value, limit: 500 } : 'skip')
);

const labelMessages = computed(() =>
	(allMessages.value?.messages ?? []).filter((m) =>
		(m.labelIds ?? []).includes(labelId.value)
	)
);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
		<div class="flex w-full">
			<aside class="w-96 border-r border-border-subtle flex flex-col bg-bg-surface">
				<header class="border-b border-border-subtle px-4 py-3">
					<h2 class="text-sm font-semibold text-text-primary">Label view</h2>
				</header>
				<PostboxQuickActionsBar :mailbox-id="mailboxId!" />
					<UiErrorAlert v-if="error" message="Couldn't load messages for this label. Reload to try again." class="m-3" />
				<div class="flex-1 overflow-auto">
					<PostboxThreadList
						:mailbox-id="mailboxId!"
						:messages="labelMessages"
						:loading="isLoading"
						folder-role="inbox"
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
