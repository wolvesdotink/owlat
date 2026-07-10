<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Mail — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
// The [folder] param is a system role (inbox/sent/…) or, for a custom folder, a
// mailFolders id. Discriminate so the layout queries by role vs by folder id.
const KNOWN_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'snoozed']);
const folderParam = computed(() => String(route.params['folder'] ?? 'inbox'));
const isCustomFolder = computed(() => !KNOWN_ROLES.has(folderParam.value));
const folderRole = computed(() => (isCustomFolder.value ? '' : folderParam.value));
const customFolderId = computed(() =>
	isCustomFolder.value ? (folderParam.value as Id<'mailFolders'>) : undefined
);
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
			:folder-role="folderRole"
			:folder-id="customFolderId"
		/>
		<!-- Error — a failed mailbox query must NOT look like "no mailbox yet" -->
		<div v-else-if="mailboxError" class="flex-1 flex items-center justify-center p-12">
			<UiErrorAlert
				title="Couldn't load your mailbox"
				message="We hit an error loading your mailbox. Reload the page to try again."
				class="max-w-md"
			/>
		</div>
		<div v-else-if="!mailboxesLoading" class="flex-1 overflow-y-auto">
			<!-- Honest, next-step-aware no-mailbox state (reserved / connect an
			     external account / ask an admin) instead of a mute wall. -->
			<PostboxMailboxGuard :mailbox-id="null" :loading="false" />
			<!-- Resumable per-user onboarding checklist so setup can be picked back up here. -->
			<div v-if="userId" class="mx-auto max-w-md px-6 pb-12">
				<OnboardingUserChecklist :user-id="userId" class="text-left" />
			</div>
		</div>
		<div v-else class="flex-1 flex items-center justify-center">
			<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
		</div>
		<PostboxComposerStack />
	</div>
</template>
