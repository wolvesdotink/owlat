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
const { currentMailbox, isLoading: mailboxesLoading, error: mailboxError } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// For the Postbox empty state: surface the resumable per-user onboarding
// checklist so a member who has no mailbox yet can pick their setup back up here.
const { user } = useAuth();
const userId = computed(() => user.value?.id ?? null);
const showGettingStarted = computed(() => !mailboxId.value && !mailboxesLoading.value);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<!-- Error — a failed mailbox query must NOT look like "no mailbox yet". -->
		<div v-if="mailboxError && !mailboxId" class="flex-1 flex items-center justify-center p-12">
			<UiErrorAlert
				:title="t('dashboard.postbox.detail.index.loadErrorTitle')"
				:message="t('dashboard.postbox.detail.index.loadErrorMessage')"
				class="max-w-md"
			/>
		</div>
		<!-- The no-mailbox state stacks the guard's next step above the onboarding
		     checklist and scrolls; every other state is the full-height row. -->
		<div v-else class="flex-1" :class="showGettingStarted ? 'overflow-y-auto' : 'flex'">
			<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
				<PostboxLayout
					:mailbox-id="mailboxId!"
					:folder-role="folder.folderRole"
					:folder-id="folder.folderId"
				/>
			</PostboxMailboxGuard>
			<!-- Resumable per-user onboarding checklist so setup can be picked back up here. -->
			<div v-if="showGettingStarted && userId" class="mx-auto max-w-md px-6 pb-12">
				<DashboardGettingStarted :user-id="userId" personal-only class="text-left" />
			</div>
		</div>
		<PostboxComposerStack />
	</div>
</template>
