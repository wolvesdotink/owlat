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
	<div class="h-[calc(100vh-4rem)] overflow-auto bg-bg-base">
		<div v-if="mailboxId" class="max-w-3xl mx-auto p-6">
			<PostboxFilesPanel :mailbox-id="mailboxId" />
		</div>
		<div v-else-if="!mailboxesLoading" class="h-full flex items-center justify-center p-12">
			<div class="text-center max-w-md">
				<Icon name="lucide:paperclip" class="w-12 h-12 mx-auto text-text-tertiary" />
				<h2 class="text-xl font-semibold mt-4">
					{{ t('dashboard.postbox.files.noMailbox') }}
				</h2>
				<p class="text-text-secondary mt-2">
					{{ t('dashboard.postbox.files.noMailboxHint') }}
				</p>
				<UiButton to="/dashboard/preferences/add-account" class="mt-6">
					{{ t('dashboard.postbox.files.addMailAccount') }}
				</UiButton>
			</div>
		</div>
		<div v-else class="h-full flex items-center justify-center">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
		</div>
	</div>
</template>
