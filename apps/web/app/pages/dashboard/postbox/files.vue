<script setup lang="ts">
/**
 * Files — a mailbox-wide browse over everything ever attached.
 *
 * A virtual destination like Subscriptions and the Reply Queue: no backing
 * folder, nothing moves. `PostboxFilesPanel` owns the facets, the listing and
 * the Quick Look overlay.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.files.pageTitle') });
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
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
				<PostboxFilesPanel :mailbox-id="mailboxId!" />
			</div>
		</PostboxMailboxGuard>
	</div>
</template>
