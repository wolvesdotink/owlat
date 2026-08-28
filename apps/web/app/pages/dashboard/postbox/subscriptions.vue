<script setup lang="ts">
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
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
</script>

<template>
	<div class="h-[calc(100vh-4rem)] overflow-auto bg-bg-base">
		<div v-if="mailboxId" class="max-w-3xl mx-auto p-6">
			<PostboxSubscriptionsPanel :mailbox-id="mailboxId" />
		</div>
		<div v-else-if="!mailboxesLoading" class="h-full flex items-center justify-center p-12">
			<div class="text-center max-w-md">
				<Icon name="lucide:mailbox" class="w-12 h-12 mx-auto text-text-tertiary" />
				<h2 class="text-xl font-semibold mt-4">
					{{ t('dashboard.postbox.subscriptions.noMailbox') }}
				</h2>
				<p class="text-text-secondary mt-2">
					{{ t('dashboard.postbox.subscriptions.noMailboxHint') }}
				</p>
				<UiButton to="/dashboard/preferences/add-account" class="mt-6">
					{{ t('dashboard.postbox.subscriptions.addMailAccount') }}
				</UiButton>
			</div>
		</div>
		<div v-else class="h-full flex items-center justify-center">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
		</div>
	</div>
</template>
