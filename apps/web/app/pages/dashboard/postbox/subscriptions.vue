<script setup lang="ts">
import { postboxPageTransition } from '~/utils/postboxPageTransition';
/**
 * Subscriptions — the mailbox-wide list-mail hygiene view.
 *
 * A virtual destination like the Reply Queue: no backing folder, nothing moves
 * until the user acts. The rail links here; `PostboxSubscriptionsPanel` owns
 * the aggregation, the selection and the batch verb.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.subscriptions.pageTitle') });
definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
</script>

<template>
	<!-- flex-col so the guard's loading and no-mailbox states fill the frame. -->
	<div class="h-[calc(100vh-4rem)] overflow-auto bg-bg-base flex flex-col">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div class="w-full max-w-3xl mx-auto p-6">
				<PostboxSubscriptionsPanel :mailbox-id="mailboxId!" />
			</div>
		</PostboxMailboxGuard>
	</div>
</template>
