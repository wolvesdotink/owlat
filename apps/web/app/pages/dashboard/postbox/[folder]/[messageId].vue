<script setup lang="ts">
import { resolvePostboxFolderParam } from '~/utils/postboxFolderParam';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.detail.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
// Same role-vs-custom-folder-id discrimination as the folder list route: passing
// the raw param through as a role queries a role that does not exist and labels
// the mobile back button with a raw Convex id.
const folder = computed(() => resolvePostboxFolderParam(route.params['folder']));
const messageId = computed(() => String(route.params['messageId'] ?? ''));
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxLayout
			v-if="mailboxId"
			:mailbox-id="mailboxId"
			:folder-role="folder.folderRole"
			:folder-id="folder.folderId"
			:active-message-id="messageId"
		/>
		<div v-else-if="!mailboxesLoading" class="flex-1 flex items-center justify-center p-12">
			<p class="text-text-secondary">{{ t('dashboard.postbox.detail.detail.noMailbox') }}</p>
		</div>
		<PostboxComposerStack />
	</div>
</template>
