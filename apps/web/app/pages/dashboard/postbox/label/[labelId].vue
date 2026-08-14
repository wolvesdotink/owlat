<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.label.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const labelId = useRouteId<'mailLabels'>('labelId');
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// Fetch all messages and filter by label client-side. P7 will replace this
// with a server-side query/index. For P3 the volume is small enough to keep
// the implementation lean.
const {
	data: allMessages,
	isLoading,
	error,
} = useConvexQuery(api.mail.mailbox.listMessages, () =>
	mailboxId.value ? { mailboxId: mailboxId.value, limit: 500 } : 'skip'
);

const labelMessages = computed(() =>
	(allMessages.value?.messages ?? []).filter((m) => (m.labelIds ?? []).includes(labelId.value))
);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div class="flex w-full">
				<aside
					class="w-full lg:w-96 lg:flex-shrink-0 border-r border-border-subtle flex flex-col bg-bg-surface"
				>
					<header class="border-b border-border-subtle px-4 py-3">
						<h2 class="text-sm font-semibold text-text-primary">
							{{ t('dashboard.postbox.label.detail.heading') }}
						</h2>
					</header>
					<PostboxQuickActionsBar :mailbox-id="mailboxId!" />
					<UiErrorAlert
						v-if="error"
						:message="t('dashboard.postbox.label.detail.loadError')"
						class="m-3"
					/>
					<div class="flex-1 overflow-auto">
						<PostboxThreadList
							:mailbox-id="mailboxId!"
							:messages="labelMessages"
							:loading="isLoading"
							folder-role="inbox"
							empty-context="label"
						/>
					</div>
				</aside>
				<!-- The list is the whole screen below lg, so the placeholder pane
				     (which has nothing to select into on a phone) drops out. -->
				<section class="flex-1 hidden lg:flex items-center justify-center text-text-secondary">
					{{ t('dashboard.postbox.label.detail.selectMessage') }}
				</section>
			</div>
		</PostboxMailboxGuard>
		<PostboxComposerStack />
		<PostboxShortcutHelp />
	</div>
</template>
