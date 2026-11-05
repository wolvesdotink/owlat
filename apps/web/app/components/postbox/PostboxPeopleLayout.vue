<script setup lang="ts">
/**
 * The conversation view: the Postbox inbox read as the people you write with,
 * then what you are talking about. It is the inbox unless the traditional
 * layout is on (`usePostboxClassicInbox`); the page picks this layout or
 * PostboxLayout.
 *
 *   pane → the mailbox, who may need a reply, and the people (or Updates)
 *   main → a person's or company's page, or the open conversation
 *
 * The folder rail is folded away (the pane's mailbox menu opens it), so a
 * conversation gets the room. Where you are lives in the URL (`?person=`,
 * `?company=`, `?view=updates`, `?focus=`), so Back, a reload and a shared
 * link land where they should. Below `lg` the pane, the page and the
 * conversation drill in one at a time.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ChevronLeftIcon } from '@coolicons/vue';
import { usePostboxListNow } from '~/composables/postbox/usePostboxListClock';
import {
	olderTopicsKey,
	usePostboxOlderTopics,
	usePostboxPeopleDirectory,
	usePostboxPeopleRoute,
	usePostboxTopicTitleRequests,
} from '~/composables/postbox/usePostboxPeople';
import {
	authorName,
	isUpdateTopic,
	pageConversations,
	paneRows,
	updateTopics,
} from '~/utils/postboxConversations';
import {
	POSTBOX_TOPIC_HEADING,
	type PeopleSelection,
	type PeopleTopic,
} from '~/utils/postboxPeople';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	activeMessageId?: string | null;
}>();

const { t } = useI18n();
const mailboxIdRef = providePostboxListMailbox(computed(() => props.mailboxId));
usePostboxCommandSurface(mailboxIdRef, {
	folderRole: computed(() => 'inbox'),
	folderId: computed(() => undefined),
});
usePostboxListNow();

const { directory, index, isLoading, error, refetch } = usePostboxPeopleDirectory(mailboxIdRef);
const { place, pageHref, updatesHref, topicHref, backToPlace, backToList } =
	usePostboxPeopleRoute();
const isShared = computed(() => directory.value?.scope === 'shared');
const isUpdates = computed(() => place.value.view === 'updates');

// Nothing chosen on a wide screen: the newest person or company in the pane.
const isWide = useMediaQuery('(min-width: 1024px)');
const fallback = computed<PeopleSelection | null>(() => {
	if (!index.value || isUpdates.value) return null;
	const first = paneRows(index.value).find((row) => row.kind !== 'group');
	if (!first) return null;
	return { kind: first.kind, key: first.key };
});
const selection = computed(() => place.value.selection ?? fallback.value);
const pageName = computed(() => {
	const s = selection.value;
	if (!s || !index.value) return null;
	return s.kind === 'person'
		? (index.value.people.get(s.key)?.name ?? null)
		: (index.value.companies.get(s.key)?.name ?? null);
});

// The open conversation, from the directory or from older mail loaded on a page.
const olderStore = usePostboxOlderTopics();
const olderTopics = computed<PeopleTopic[]>(() => {
	const s = place.value.selection;
	const email = s?.kind === 'person' ? index.value?.people.get(s.key)?.email : undefined;
	return email ? (olderStore.value[olderTopicsKey(props.mailboxId, email)]?.topics ?? []) : [];
});
const openTopic = computed(() =>
	props.activeMessageId
		? [...(directory.value?.topics ?? []), ...olderTopics.value].find(
				(x) => x.latestMessageId === props.activeMessageId
			)
		: undefined
);

// What j/k step through in the reader: the list the conversation was opened from.
const listTopics = computed<PeopleTopic[]>(() => {
	if (!index.value) return [];
	if (isUpdates.value) return updateTopics(index.value, place.value.from);
	const s = place.value.selection;
	if (!s) return [];
	const owner =
		s.kind === 'person' ? index.value.people.get(s.key) : index.value.companies.get(s.key);
	const { current, earlier } = pageConversations(index.value, owner?.topicIds ?? [], {
		focus: place.value.focus,
		memberKey: place.value.member,
	});
	return [...current, ...earlier];
});
const stepIds = computed(() =>
	listTopics.value.flatMap((x) => (x.latestMessageId ? [x.latestMessageId] : []))
);

const hrefForTopic = (topic: PeopleTopic) => topicHref(topic, place.value);
const hrefFromPane = (topic: PeopleTopic) =>
	topicHref(topic, isUpdates.value ? { view: 'updates', from: place.value.from } : null);

const backLabel = computed(() =>
	isUpdates.value
		? t('components.postbox.conversations.pane.updates')
		: (pageName.value ?? t('components.postbox.conversations.pane.people'))
);

// The reader heads the conversation with its topic, renamed where it is read,
// and ends it with the reply field.
const renameOp = useBackendOperation(api.mail.people.topicTitle.renameTopic, {
	label: () => t('components.postbox.conversations.topic.rename'),
});
const resetOp = useBackendOperation(api.mail.people.topicTitle.resetTopicTitle, {
	label: () => t('components.postbox.conversations.topic.reset'),
});
const clearOp = useBackendOperation(api.mail.needsReply.clear, {
	label: () => t('components.postbox.conversations.cue.noReply'),
});
const restoreOp = useBackendOperation(api.mail.needsReplyRestore.restore, {
	label: () => t('components.postbox.conversations.cue.noReplyUndone'),
});
const triageUndo = usePostboxTriageUndo();
async function markNoReply(topic: PeopleTopic) {
	const threadId = topic.id as Id<'mailThreads'>;
	if (!(await clearOp.run({ threadId })).ok) return;
	triageUndo.register({
		label: t('components.postbox.conversations.cue.markedNoReply', { title: topic.title }),
		inverse: async () => {
			await restoreOp.run({ threadId });
		},
	});
}
provide(
	POSTBOX_TOPIC_HEADING,
	computed(() => {
		const topic = openTopic.value;
		if (!topic || !index.value) return null;
		const threadId = topic.id as Id<'mailThreads'>;
		const to = topic.latestFromKey ?? topic.partyKeys.find((k) => index.value?.people.has(k));
		return {
			title: topic.title,
			subject: topic.subject,
			source: topic.titleSource,
			rename: async (title: string) => {
				await renameOp.run({ threadId, title });
			},
			reset: async () => {
				await resetOp.run({ threadId });
			},
			...(topic.turn === 'you' ? { noReply: () => markNoReply(topic) } : {}),
			...(isUpdateTopic(index.value, topic)
				? {}
				: { hasReplyField: true, ...(to ? { replyTo: authorName(index.value, to) } : {}) }),
			...(topic.hasSuggestedReply ? { hasSuggestedReply: true } : {}),
		};
	})
);

// The app's breadcrumb follows the path: Inbox › person (or Updates) › topic.
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();
const placeHref = computed(() =>
	isUpdates.value
		? updatesHref(place.value.from)
		: selection.value
			? pageHref(selection.value)
			: '/dashboard/postbox/inbox'
);
watch(
	[backLabel, placeHref, () => openTopic.value?.title, () => props.activeMessageId],
	() => {
		const isPlaced = isUpdates.value || !!place.value.selection;
		if (!isPlaced && !openTopic.value) {
			clearDynamicBreadcrumbs();
			return;
		}
		setDynamicBreadcrumbs([
			// The trail translates its labels: a message key, where there is one.
			{ label: 'components.postbox.conversations.pane.inbox', href: '/dashboard/postbox/inbox' },
			...(isPlaced
				? [
						props.activeMessageId
							? { label: backLabel.value, href: placeHref.value }
							: { label: backLabel.value },
					]
				: []),
			...(props.activeMessageId && openTopic.value ? [{ label: openTopic.value.title }] : []),
		]);
	},
	{ immediate: true }
);
onBeforeUnmount(clearDynamicBreadcrumbs);

// Titles for what is on screen: the page's conversations and the open one.
usePostboxTopicTitleRequests(
	mailboxIdRef,
	computed(() => [
		...(openTopic.value ? [openTopic.value] : []),
		...(isUpdates.value ? [] : listTopics.value.slice(0, 24)),
	])
);

const activeRead = usePostboxActiveMessageRead({
	activeMessageId: () => props.activeMessageId,
	listRows: () => [],
});

const foldersOpen = ref(false);
const route = useRoute();
watch(
	() => route.fullPath,
	() => {
		foldersOpen.value = false;
	},
	{ flush: 'post' }
);

// Below lg one pane at a time: the list until a page or a conversation is open.
const isDetailOpen = computed(() => !!place.value.selection || !!props.activeMessageId);

// Focus follows the drill-in where the pane hides: into the page's heading on
// the way in, onto the conversation's header when one opens.
const pageRef = ref<{ focusHeading: () => void } | null>(null);
const mainEl = ref<HTMLElement | null>(null);
watch(
	() => place.value.selection?.key ?? null,
	async (key) => {
		await nextTick();
		if (key && !isWide.value) pageRef.value?.focusHeading();
	}
);
watch(
	() => props.activeMessageId ?? null,
	async (id) => {
		await nextTick();
		if (id) mainEl.value?.querySelector<HTMLElement>('[data-reader-chrome="header"]')?.focus();
	}
);
</script>

<template>
	<div class="flex w-full min-w-0">
		<PostboxFolderDrawer
			v-model:open="foldersOpen"
			:mailbox-id="mailboxId"
			folder-role="inbox"
			zen
		/>

		<div
			class="w-full min-w-0 flex-shrink-0 border-r border-border-subtle lg:flex lg:w-[21.5rem]"
			:class="isDetailOpen ? 'hidden' : 'flex'"
		>
			<PostboxConversationPane
				:mailbox-id="mailboxId"
				:index="index"
				:place="place"
				:active-topic-id="openTopic?.id ?? null"
				:page-href="pageHref"
				:updates-href="updatesHref"
				:topic-href="hrefFromPane"
				:is-loading="isLoading"
				:error="error"
				@open-folders="foldersOpen = true"
				@retry="refetch"
			/>
		</div>

		<main
			ref="mainEl"
			class="min-w-0 flex-1 flex-col lg:flex"
			:class="[
				isDetailOpen ? 'flex' : 'hidden',
				activeMessageId ? 'bg-bg-base' : 'bg-bg-elevated/40',
			]"
			:aria-label="backLabel"
		>
			<template v-if="activeMessageId">
				<!-- Wide screens: the way back to where the conversation was opened.
				     Below lg the reader's own back bar does it. -->
				<div class="hidden px-6 pt-4 lg:block">
					<button
						type="button"
						class="mx-auto flex w-full max-w-4xl items-center gap-1 px-6 text-[0.8125rem] text-text-tertiary hover:text-text-primary"
						@click="backToPlace"
					>
						<ChevronLeftIcon class="h-3.5 w-3.5" />
						{{ backLabel }}
					</button>
				</div>
				<PostboxReaderPane
					class="@container min-h-0 flex-1 overflow-auto"
					:active-message-id="activeMessageId"
					:message="activeRead.message.value"
					:advance-ids="stepIds"
					:step-ids="stepIds"
					folder-path="inbox"
					:folder-name="backLabel"
					:zen="false"
					:error="activeRead.error.value"
					:not-found="activeRead.notFound.value"
					@retry="activeRead.refetch"
					@back="backToPlace"
				/>
			</template>
			<div v-else class="min-h-0 flex-1 overflow-y-auto">
				<button
					v-if="place.selection || isUpdates"
					type="button"
					class="ml-3 mt-1 inline-flex min-h-11 items-center gap-1 rounded px-2 text-[0.8125rem] text-text-secondary hover:bg-bg-surface lg:hidden"
					@click="backToList"
				>
					<ChevronLeftIcon class="h-3.5 w-3.5" />
					{{ t('components.postbox.conversations.pane.people') }}
				</button>
				<Transition name="pbx-fade" mode="out-in">
					<PostboxConversationPage
						v-if="index && selection && pageName && !isUpdates"
						ref="pageRef"
						:key="`${selection.kind}:${selection.key}`"
						:mailbox-id="mailboxId"
						:index="index"
						:selection="selection"
						:focus="place.focus"
						:member="place.member"
						:is-shared="isShared"
						:page-href="pageHref"
						:updates-href="updatesHref"
						:topic-href="hrefForTopic"
						@no-reply="markNoReply"
					/>
					<p
						v-else-if="index && !isLoading"
						class="mx-auto max-w-md px-6 py-24 text-center text-sm text-text-tertiary"
					>
						{{
							isUpdates
								? t('components.postbox.conversations.page.pickUpdate')
								: place.selection
									? t('components.postbox.conversations.page.gone')
									: t('components.postbox.conversations.pane.emptyTitle')
						}}
					</p>
				</Transition>
			</div>
		</main>

		<PostboxShortcutHelp />
	</div>
</template>
