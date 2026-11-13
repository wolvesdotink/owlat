<script setup lang="ts">
import { resolvePostboxFolderParam } from '~/utils/postboxFolderParam';
import { unifiedFolderRole } from '~/utils/postboxAllInboxes';
import { warmPostboxThreadReader } from '~/composables/postbox/usePostboxChunkWarmup';
import { POSTBOX_PAGE_KEY, postboxPageTransition } from '~/utils/postboxPageTransition';

// One page for the folder list and the open message (/inbox and /inbox/<id>).
// The constant key keeps PostboxLayout mounted across opens, j/k, back and
// folder switches, so the rail, the loaded list pages, the scroll position,
// the keyboard focus and the reader's own transition all survive; the layout
// reacts to the folder and the message id as props. See utils/postboxPageTransition.
const { t } = useI18n();

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
	requiresAnyFeature: ['postbox', 'mail.external'],
	key: POSTBOX_PAGE_KEY,
});

const route = useRoute();
// The [folder] param is a system role (inbox/sent/…) or, for a custom folder, a
// mailFolders id — the layout queries by role vs by folder id accordingly.
// Passing the raw param through as a role would query a role that does not
// exist and label the mobile back button with a raw Convex id.
const folder = computed(() => resolvePostboxFolderParam(route.params['folder']));
// All inboxes and the unified folders are folder routes of their own
// (utils/postboxAllInboxes.ts): the list and the reader build their links from
// this segment, so they stay in it.
const unifiedRole = computed(() => unifiedFolderRole(route.params['folder']));
// The optional [[messageId]] param: absent (or empty) on the folder list.
const messageId = computed(() => {
	const param = route.params['messageId'];
	return typeof param === 'string' && param !== '' ? param : null;
});

useHead({
	title: () =>
		messageId.value
			? t('dashboard.postbox.detail.detail.pageTitle')
			: unifiedRole.value
				? t(`components.postbox.allInboxes.roles.${unifiedRole.value}`)
				: t('dashboard.postbox.detail.index.pageTitle'),
});

// The open message's thread and body start loading from the route right away,
// in parallel with the mailbox and the list (plan 2.5); the reader joins them.
usePostboxOpenMessage(messageId);
// The reader's code is not part of this page (PostboxReaderPane mounts it
// lazily), so a route that names a message starts that download here too,
// instead of after the list and the message have arrived.
watch(messageId, (id) => id && void warmPostboxThreadReader(), { immediate: true });

// Seeded from the persisted choice once the shell's accessible mailboxes vouch
// for it, so the list does not wait for the mailbox list (plan 2.5).
const { mailboxId, isLoading: mailboxesLoading, error: mailboxError } = usePostboxMailbox();
// The guard spins only while there is no mailbox to render with yet.
const guardLoading = computed(() => mailboxesLoading.value && !mailboxId.value);
// Prefetched and just-read bodies outlive the list and reader; they are
// dropped when the mailbox, user or organization changes.
usePostboxBodyCacheScope(mailboxId);

// For the Postbox empty state: surface the resumable per-user onboarding
// checklist so a member who has no mailbox yet can pick their setup back up here.
const { user } = useAuth();
const userId = computed(() => user.value?.id ?? null);
const showGettingStarted = computed(() => !mailboxId.value && !mailboxesLoading.value);
</script>

<template>
	<div
		class="flex h-[calc(100dvh-var(--shell-chrome-mobile-h))] lg:h-[calc(100dvh-var(--titlebar-h,0px)-var(--shell-chrome-h,4rem))]"
	>
		<!-- Error — a failed mailbox query must NOT look like "no mailbox yet". -->
		<div v-if="mailboxError && !mailboxId" class="flex-1 flex items-center justify-center p-12">
			<UiErrorAlert
				:title="t('dashboard.postbox.detail.index.loadErrorTitle')"
				:message="t('dashboard.postbox.detail.index.loadErrorMessage')"
				class="max-w-md"
			/>
		</div>
		<!-- The no-mailbox state stacks the guard's next step above the onboarding
		     checklist and scrolls; every other state is the full-height row.
		     min-w-0: without it the nowrap row snippets set this flex item's
		     minimum width and the Postbox scrolled sideways on a phone. -->
		<div v-else class="min-w-0 flex-1" :class="showGettingStarted ? 'overflow-y-auto' : 'flex'">
			<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="guardLoading">
				<!-- Lazy: only the unified folders render it, and every other folder
				     would otherwise download it with the page. -->
				<LazyPostboxAllInboxesLayout
					v-if="unifiedRole"
					:role="unifiedRole"
					:active-message-id="messageId"
				/>
				<PostboxLayout
					v-else
					:mailbox-id="mailboxId!"
					:folder-role="folder.folderRole"
					:folder-id="folder.folderId"
					:active-message-id="messageId"
				/>
			</PostboxMailboxGuard>
			<!-- Resumable per-user onboarding checklist so setup can be picked back up here. -->
			<div v-if="showGettingStarted && userId" class="mx-auto max-w-md px-6 pb-12">
				<DashboardGettingStarted :user-id="userId" personal-only class="text-left" />
			</div>
		</div>
	</div>
</template>
