<script setup lang="ts">
import { postboxPageTransition } from '~/utils/postboxPageTransition';
/**
 * Senders — who writes to you, and what Owlat does with their mail (SPEC §5).
 *
 * A virtual destination like the Reply Queue: no backing folder. The rail
 * links here. It is also the one place for list-mail hygiene: the old
 * Subscriptions panel (every inbox sender with a List-Unsubscribe header,
 * including mail from before sender profiles existed) sits below the senders,
 * and `/dashboard/postbox/subscriptions` redirects here.
 */
const { t } = useI18n();

useHead({ title: () => t('postbox.senders.pageTitle') });
definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const {
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
</script>

<template>
	<!-- flex-col so the guard's loading and no-mailbox states fill the frame. -->
	<div class="h-[calc(100vh-var(--shell-chrome-h,4rem))] overflow-auto bg-bg-base flex flex-col">
		<PostboxMailboxGuard
			:mailbox-id="mailboxId"
			:loading="mailboxesLoading"
			:error="mailboxesError"
			@retry="refetchMailboxes"
		>
			<div class="w-full max-w-5xl mx-auto p-6 flex flex-col gap-6">
				<PostboxSendersPanel :mailbox-id="mailboxId!" />
				<PostboxSubscriptionsPanel :mailbox-id="mailboxId!" />
			</div>
		</PostboxMailboxGuard>
	</div>
</template>
