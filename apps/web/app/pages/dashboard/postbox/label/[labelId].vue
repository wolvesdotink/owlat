<script setup lang="ts">
import { postboxPageTransition } from '~/utils/postboxPageTransition';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxMarkReadCommands } from '~/composables/postbox/usePostboxCommandSurface';
import { useBlockSize } from '~/composables/postbox/useBlockSize';
import { ArrowLeftIcon, MailOpenIcon } from '@coolicons/vue';

const { t } = useI18n();

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', postboxPageTransition],
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const labelId = useRouteId<'mailLabels'>('labelId');
const {
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// Server-side label view: `listByLabel` scans the mailbox's newest messages
// server-side and returns only rows carrying this label. Replaces the P3
// stopgap that fetched up to 500 recent mailbox messages to the browser and
// filtered labelIds client-side.
//
// The view is bounded, not cursor-paged: the backend scans its fixed window
// (LABEL_SCAN_WINDOW) and slices it to `limit`, so a single fetch at the
// display cap gets everything the view can reach. When matches overflow even
// that slice (`hasMore`), the honest cap note renders — there is no deeper
// page to load, by design, until label membership gets a real index.
const {
	data: labelData,
	isLoading,
	error,
} = useConvexQuery(
	api.mail.mailbox.queries.listByLabel,
	() =>
		mailboxId.value ? { mailboxId: mailboxId.value, labelId: labelId.value, limit: 500 } : 'skip',
	{ keepPreviousData: true }
);
const labelMessages = computed(() => labelData.value?.messages ?? []);
/** Matches exist beyond the display slice (within the backend's scan window). */
const overCap = computed(() => labelData.value?.hasMore ?? false);

// "Mark all as read" covers every unread message carrying the label, in any
// folder, not only the rows this bounded view lists.
const { labels, unreadCounts } = usePostboxLabels(mailboxId);
// The page names the label it shows, in the header and the tab title; until
// the labels have loaded it falls back to the generic heading.
const currentLabel = computed(() => labels.value.find((l) => l._id === labelId.value) ?? null);
useHead({
	title: () =>
		currentLabel.value
			? t('dashboard.postbox.label.detail.pageTitleNamed', { label: currentLabel.value.name })
			: t('dashboard.postbox.label.detail.pageTitle'),
});

// A row opens beside the list, as on the search page: the label view keeps its
// own list rather than handing the reader to the Inbox route. Below lg the
// reader takes the screen, with a back bar to the list.
const activeMessageId = ref<string | null>(null);
watch(labelMessages, (rows) => {
	if (activeMessageId.value && !rows.some((m) => m._id === activeMessageId.value)) {
		activeMessageId.value = null;
	}
});
watch(labelId, () => {
	activeMessageId.value = null;
});
const {
	data: activeMessage,
	error: activeMessageError,
	refetch: refetchActiveMessage,
} = useConvexQuery(api.mail.mailbox.messages.getMessage, () =>
	activeMessageId.value ? { messageId: activeMessageId.value as Id<'mailMessages'> } : 'skip'
);
const backBarEl = ref<HTMLElement | null>(null);
const backBarHeight = useBlockSize(() => backBarEl.value);
const labelUnread = computed(() => unreadCounts.value[labelId.value] ?? 0);
const markReadTarget = computed(() =>
	mailboxId.value
		? { kind: 'label' as const, mailboxId: mailboxId.value, labelId: labelId.value }
		: null
);
usePostboxMarkReadCommands('label', mailboxId, () =>
	markReadTarget.value && labelUnread.value > 0
		? [
				{
					key: 'label',
					label: t('components.postbox.postboxFolderActions.markAllRead'),
					target: markReadTarget.value,
				},
			]
		: []
);
</script>

<template>
	<div
		class="flex h-[calc(100dvh-var(--shell-chrome-mobile-h))] lg:h-[calc(100dvh-var(--titlebar-h,0px)-var(--shell-chrome-h,4rem))]"
	>
		<PostboxMailboxGuard
			:mailbox-id="mailboxId"
			:loading="mailboxesLoading"
			:error="mailboxesError"
			@retry="refetchMailboxes"
		>
			<div class="flex w-full min-w-0">
				<aside
					class="w-full lg:w-96 lg:flex-shrink-0 border-r border-border-subtle flex-col bg-bg-surface"
					:class="activeMessageId ? 'hidden lg:flex' : 'flex'"
				>
					<header
						class="border-b border-border-subtle px-4 py-3 flex items-center justify-between gap-2"
					>
						<h2 class="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
							<span
								v-if="currentLabel"
								class="h-2 w-2 flex-shrink-0 rounded-full"
								:class="{ 'bg-text-tertiary': !currentLabel.color }"
								:style="currentLabel.color ? { backgroundColor: currentLabel.color } : undefined"
								aria-hidden="true"
							/>
							<span class="truncate">{{
								currentLabel?.name ?? t('dashboard.postbox.label.detail.heading')
							}}</span>
						</h2>
						<!-- The 36px trigger would grow the 20px title row: the negative
						     margin keeps the header the height it has without it. -->
						<PostboxMarkReadMenu
							v-if="markReadTarget"
							class="-my-2"
							:target="markReadTarget"
							:enabled="labelUnread > 0"
							:label="t('components.postbox.postboxFolderActions.labelMenuLabel')"
							:mailbox-id="mailboxId"
						/>
					</header>
					<PostboxQuickActionsBar :mailbox-id="mailboxId!" />
					<UiErrorAlert
						v-if="error"
						:message="t('dashboard.postbox.label.detail.loadError')"
						class="m-3"
					/>
					<p v-if="overCap" class="px-4 py-2 text-xs text-text-tertiary" role="status">
						{{ t('dashboard.postbox.label.detail.capNote', { count: 500 }, 500) }}
					</p>
					<div class="flex-1 overflow-auto">
						<PostboxThreadList
							:mailbox-id="mailboxId!"
							:messages="labelMessages"
							:loading="isLoading"
							folder-role="inbox"
							empty-context="label"
							selectable
							:active-message-id="activeMessageId"
							:list-path="`/dashboard/postbox/label/${labelId}`"
							@select="activeMessageId = $event"
						/>
					</div>
				</aside>
				<section
					class="flex-1 min-w-0 overflow-auto bg-bg-base"
					:class="activeMessageId ? 'block' : 'hidden lg:block'"
					:style="{ '--pbx-reader-sticky-top': `${backBarHeight}px` }"
				>
					<div
						v-if="activeMessageId"
						ref="backBarEl"
						class="lg:hidden sticky top-0 z-10 flex items-center border-b border-border-subtle bg-bg-base px-2"
					>
						<button
							type="button"
							class="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40 outline-none rounded px-2 py-3"
							@click="activeMessageId = null"
						>
							<ArrowLeftIcon class="w-4 h-4" aria-hidden="true" />
							{{
								t('components.postbox.postboxMessageNotFound.backTo', {
									folder: currentLabel?.name ?? t('dashboard.postbox.label.detail.heading'),
								})
							}}
						</button>
					</div>
					<AppErrorBoundary v-if="activeMessage" surface="reader" :reset-keys="[activeMessageId]">
						<!-- Lazy: the label view opens on its list, and most visits read
						     no message, so the reader loads with the first opened row. -->
						<LazyPostboxThreadReader :key="activeMessageId ?? undefined" :message="activeMessage" />
					</AppErrorBoundary>
					<UiQueryBoundary
						v-else-if="activeMessageId && activeMessageError"
						:error="activeMessageError"
						@retry="refetchActiveMessage"
					/>
					<PostboxMessageNotFound v-else-if="activeMessageId && activeMessage === null">
						<template #action>
							<UiButton variant="secondary" @click="activeMessageId = null">
								{{
									t('components.postbox.postboxMessageNotFound.backTo', {
										folder: currentLabel?.name ?? t('dashboard.postbox.label.detail.heading'),
									})
								}}
							</UiButton>
						</template>
					</PostboxMessageNotFound>
					<div v-else-if="activeMessageId" class="p-6">
						<PostboxReaderSkeleton />
					</div>
					<div v-else class="h-full flex items-center justify-center">
						<div class="text-center">
							<MailOpenIcon class="w-12 h-12 mx-auto text-text-tertiary" :stroke-width="1.5" />
							<p class="mt-4 text-text-secondary">
								{{ t('dashboard.postbox.label.detail.selectMessage') }}
							</p>
						</div>
					</div>
				</section>
			</div>
		</PostboxMailboxGuard>
		<PostboxShortcutHelp />
	</div>
</template>
