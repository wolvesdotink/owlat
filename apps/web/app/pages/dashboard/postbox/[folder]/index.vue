<script setup lang="ts">
import { resolvePostboxFolderParam } from '~/utils/postboxFolderParam';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.detail.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
// The [folder] param is a system role (inbox/sent/…) or, for a custom folder, a
// mailFolders id — the layout queries by role vs by folder id accordingly.
const folder = computed(() => resolvePostboxFolderParam(route.params['folder']));
const {
	mailboxes,
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxError,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// For the Postbox empty state: surface the resumable per-user onboarding
// checklist so a member who has no mailbox yet can pick their setup back up here.
const { user } = useAuth();
const userId = computed(() => user.value?.id ?? null);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxLayout
			v-if="mailboxId"
			:mailbox-id="mailboxId"
			:folder-role="folder.folderRole"
			:folder-id="folder.folderId"
		/>
		<!-- Error — a failed mailbox query must NOT look like "no mailbox yet" -->
		<div v-else-if="mailboxError" class="flex-1 flex items-center justify-center p-12">
			<UiErrorAlert
				:title="t('dashboard.postbox.detail.index.loadErrorTitle')"
				:message="t('dashboard.postbox.detail.index.loadErrorMessage')"
				class="max-w-md"
			/>
		</div>
		<div v-else-if="!mailboxesLoading" class="flex-1 overflow-y-auto">
			<!-- Honest, next-step-aware no-mailbox state (reserved / connect an
			     external account / ask an admin) instead of a mute wall. -->
			<PostboxMailboxGuard :mailbox-id="null" :loading="false" />
			<!-- Resumable per-user onboarding checklist so setup can be picked back up here. -->
			<div v-if="userId" class="mx-auto max-w-md px-6 pb-12">
				<DashboardGettingStarted :user-id="userId" personal-only class="text-left" />
			</div>
		</div>
		<div v-else class="flex-1 flex items-center justify-center">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin motion-reduce:animate-none text-text-tertiary" />
		</div>
		<PostboxComposerStack />
	</div>
</template>
