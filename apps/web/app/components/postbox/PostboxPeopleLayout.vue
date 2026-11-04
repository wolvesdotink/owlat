<script setup lang="ts">
/**
 * The People view: the inbox read as who you are talking to, then what about.
 * It is the Postbox inbox unless the person turned the classic inbox on in
 * Settings (`usePostboxClassicInbox`); the page picks this layout or
 * PostboxLayout. The folder rail stays beside it, so Sent, Archive and every
 * folder are where they always were.
 *
 *   column  → people and companies (PostboxPeopleColumn)
 *   main    → the selected person's or company's page, or, once a topic is
 *             open, the bar naming it above the ordinary reader
 *
 * The page lives in the URL (`?person=` / `?company=`), so Back, a reload and
 * a shared link land where they should; the reader keeps it on every route it
 * builds. Wide screens show the first person who waits on you when nothing is
 * chosen; below `lg` the column, the page and the topic drill in one by one.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ChevronLeftIcon } from '@coolicons/vue';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { ShortcutScope } from '~/utils/shortcutRegistry';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import { resolveActiveChord } from '~/utils/shortcutScope';
import { POSTBOX_LIST_QUERY } from '~/composables/postbox/usePostboxPlacementFilter';
import { usePostboxListNow } from '~/composables/postbox/usePostboxListClock';
import {
	olderTopicsKey,
	usePostboxOlderTopics,
	usePostboxPeopleDirectory,
	usePostboxPeopleRoute,
	usePostboxTopicTitleRequests,
} from '~/composables/postbox/usePostboxPeople';
import {
	POSTBOX_TOPIC_HEADING,
	leadTopic,
	peopleSections,
	selectionQuery,
	splitTopics,
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

const { directory, topics, people, companies, accounts, isLoading, error, refetch } =
	usePostboxPeopleDirectory(mailboxIdRef);
const {
	selection: chosen,
	pageHref,
	topicHref,
	backToPage,
	backToColumn,
} = usePostboxPeopleRoute();

// Nothing chosen: the first person waiting on you, else the first one at all.
const fallback = computed<PeopleSelection | null>(() => {
	if (!directory.value) return null;
	const { waiting, maybe, active, quiet, companies: listed } = peopleSections(directory.value, '');
	const first = waiting[0] ?? maybe[0] ?? active[0] ?? quiet[0];
	if (first) return { kind: 'person', key: first.key };
	return listed[0] ? { kind: 'company', key: listed[0].key } : null;
});
const selection = computed(() => chosen.value ?? fallback.value);
const person = computed(() =>
	selection.value?.kind === 'person' ? people.value.get(selection.value.key) : undefined
);
const company = computed(() =>
	selection.value?.kind === 'company' ? companies.value.get(selection.value.key) : undefined
);
const isShared = computed(() => directory.value?.scope === 'shared');

const names = computed(() => {
	const map = new Map<string, string>();
	for (const p of directory.value?.people ?? []) map.set(p.key, p.name);
	for (const a of directory.value?.accounts ?? []) map.set(a.key, a.name);
	return map;
});

// The page's topics in the page's own order (current, waiting on you first,
// then earlier): what the topic column lists and j/k in the reader step through.
// With the older ones "Show older mail" loaded for this person, so an old
// conversation opens with its name and its place in the column too.
const olderStore = usePostboxOlderTopics();
const olderTopics = computed<PeopleTopic[]>(() =>
	person.value
		? (olderStore.value[olderTopicsKey(props.mailboxId, person.value.email)]?.topics ?? [])
		: []
);
const pageTopics = computed<PeopleTopic[]>(() => {
	const ids = person.value?.topicIds ?? company.value?.topicIds ?? [];
	const known = new Set(ids);
	const { now, earlier } = splitTopics([
		...ids.map((id) => topics.value.get(id)).filter((x): x is PeopleTopic => !!x),
		...olderTopics.value.filter((x) => !known.has(x.id)),
	]);
	return [...now, ...earlier];
});
const openTopic = computed(() =>
	props.activeMessageId
		? [...(directory.value?.topics ?? []), ...olderTopics.value].find(
				(x) => x.latestMessageId === props.activeMessageId
			)
		: undefined
);
const stepIds = computed(() =>
	pageTopics.value.flatMap((x) => (x.latestMessageId ? [x.latestMessageId] : []))
);

// The reader heads the open conversation with its topic name, renamed where
// it is read.
const renameOp = useBackendOperation(api.mail.people.topicTitle.renameTopic, {
	label: () => t('components.postbox.people.topicBar.rename'),
});
// "No reply needed" from the reader, where the decision is usually made, with
// the same undo as the card's.
const clearOp = useBackendOperation(api.mail.needsReply.clear, {
	label: () => t('components.postbox.people.topic.noReplyNeeded'),
});
const restoreOp = useBackendOperation(api.mail.needsReplyRestore.restore, {
	label: () => t('components.postbox.people.topic.noReplyUndone'),
});
const triageUndo = usePostboxTriageUndo();
async function markNoReply(topic: PeopleTopic) {
	const threadId = topic.id as Id<'mailThreads'>;
	if (!(await clearOp.run({ threadId })).ok) return;
	triageUndo.register({
		label: t('components.postbox.people.topic.markedNoReplyOn', { title: topic.title }),
		inverse: async () => {
			await restoreOp.run({ threadId });
		},
	});
}
const resetOp = useBackendOperation(api.mail.people.topicTitle.resetTopicTitle, {
	label: () => t('components.postbox.people.topicBar.reset'),
});
provide(
	POSTBOX_TOPIC_HEADING,
	computed(() => {
		const topic = openTopic.value;
		if (!topic) return null;
		const threadId = topic.id as Id<'mailThreads'>;
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
		};
	})
);

// The app's own breadcrumb follows the People path: Inbox › person › topic.
// On a phone the fallback page is not on screen (the column is), so the trail
// names a page only once one was opened.
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();
const isWide = useMediaQuery('(min-width: 1024px)');
watch(
	[
		selection,
		() => person.value?.name ?? company.value?.name,
		() => openTopic.value?.title,
		isWide,
	],
	() => {
		const page = isWide.value || chosen.value || openTopic.value ? selection.value : null;
		const name = person.value?.name ?? company.value?.name;
		if (!page || !name) {
			clearDynamicBreadcrumbs();
			return;
		}
		setDynamicBreadcrumbs([
			{ label: t('components.postbox.people.column.inbox'), href: '/dashboard/postbox/inbox' },
			props.activeMessageId ? { label: name, href: pageHref(page) } : { label: name },
			...(props.activeMessageId && openTopic.value ? [{ label: openTopic.value.title }] : []),
		]);
	},
	{ immediate: true }
);
onBeforeUnmount(clearDynamicBreadcrumbs);

// Every route the reader builds keeps the page, so Back and j/k stay on it.
provide(
	POSTBOX_LIST_QUERY,
	computed(() =>
		chosen.value ? `?${new URLSearchParams(selectionQuery(chosen.value)).toString()}` : ''
	)
);

// Titles for what is on screen: the page's topics and each column row's lead.
usePostboxTopicTitleRequests(
	mailboxIdRef,
	computed(() => {
		const leads = (directory.value?.people ?? [])
			.slice(0, 30)
			.map((p) => leadTopic(p.topicIds, topics.value))
			.filter((x): x is PeopleTopic => !!x);
		return [...pageTopics.value.slice(0, 20), ...leads];
	})
);

const activeRead = usePostboxActiveMessageRead({
	activeMessageId: () => props.activeMessageId,
	listRows: () => [],
});
const hrefForTopic = (topic: PeopleTopic) => topicHref(topic, selection.value);
const backLabel = computed(
	() => person.value?.name ?? company.value?.name ?? t('components.postbox.people.column.inbox')
);

const railOpen = ref(false);
const route = useRoute();
watch(
	() => route.fullPath,
	() => {
		railOpen.value = false;
	},
	{ flush: 'post' }
);

// j/k (the Postbox's own next/previous, remaps and presets included) reach the
// column from anywhere on the view: from the page, from nowhere at all after a
// click. Inside the column or a page their own handlers move first and claim
// the key, so this only picks up what nothing else took.
const PEOPLE_SCOPES: readonly ShortcutScope[] = ['postbox'];
function onWindowKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || props.activeMessageId) return;
	if (isEditableTarget(event.target) || isDialogOpen()) return;
	const id = resolveActiveChord(chordFromEvent(event), PEOPLE_SCOPES);
	if (id !== 'postbox.next' && id !== 'postbox.previous') return;
	const rows = [...(columnEl.value?.querySelectorAll<HTMLElement>('[data-people-row]') ?? [])];
	if (rows.length === 0 || !columnEl.value?.offsetParent) return;
	event.preventDefault();
	const current = rows.findIndex((row) => row.getAttribute('aria-current') === 'page');
	const next = current < 0 ? 0 : current + (id === 'postbox.next' ? 1 : -1);
	rows[Math.min(rows.length - 1, Math.max(0, next))]?.focus();
}
// oxlint-disable-next-line owlat/no-raw-keydown-listener -- resolves postbox.next and postbox.previous through the registry
onMounted(() => window.addEventListener('keydown', onWindowKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown));

// Below lg one pane at a time: the column until a page is chosen or a topic is open.
const isDetailOpen = computed(() => !!chosen.value || !!props.activeMessageId);

// Focus follows the drill-in where the column hides (below lg): into the
// page's heading on the way down, back onto the row it came from on the way
// up. Beside the column (lg and up) focus stays where the person put it, so
// j/k keep walking the rows.
const columnEl = ref<HTMLElement | null>(null);
const pageRef = ref<{ focusHeading: () => void } | null>(null);
watch(
	() => chosen.value?.key ?? null,
	async (key, previous) => {
		await nextTick();
		const isColumnHidden = !columnEl.value?.offsetParent;
		if (key && isColumnHidden) {
			pageRef.value?.focusHeading();
		} else if (!key && previous) {
			const row = [
				...(columnEl.value?.querySelectorAll<HTMLElement>('[data-people-row]') ?? []),
			].find((el) => decodeURIComponent(el.getAttribute('href') ?? '').includes(`=${previous}`));
			row?.focus();
		}
	}
);

// Opening a topic moves focus into the reader's header, unless it was opened
// from the topics column, where j/k keep walking; closing it returns focus to
// the card it was opened from.
const mainEl = ref<HTMLElement | null>(null);
watch(
	() => props.activeMessageId ?? null,
	async (id, previous) => {
		const fromColumn = columnEl.value?.contains(document.activeElement) ?? false;
		await nextTick();
		if (id && !fromColumn) {
			mainEl.value?.querySelector<HTMLElement>('[data-reader-chrome="header"]')?.focus();
		} else if (!id && previous) {
			const card = [
				...(mainEl.value?.querySelectorAll<HTMLElement>('[data-topic-card] a') ?? []),
			].find((el) => (el.getAttribute('href') ?? '').includes(previous));
			card?.focus();
		}
	}
);
</script>

<template>
	<div class="flex w-full min-w-0">
		<PostboxFolderDrawer v-model:open="railOpen" :mailbox-id="mailboxId" folder-role="inbox" />

		<div
			ref="columnEl"
			class="w-full min-w-0 flex-shrink-0 border-r border-border-subtle lg:flex lg:w-[22rem] xl:w-[24rem]"
			:class="isDetailOpen ? 'hidden' : 'flex'"
		>
			<PostboxTopicsColumn
				v-if="activeMessageId && (person || company)"
				:name="backLabel"
				:kind="person ? 'person' : 'company'"
				:color-key="person?.key"
				:logo-url="company?.logoUrl"
				:topics="pageTopics"
				:active-message-id="activeMessageId"
				:href-for="hrefForTopic"
				:is-shared="isShared"
				@back="backToPage"
			/>
			<PostboxPeopleColumn
				v-else
				:directory="directory"
				:topics="topics"
				:companies="companies"
				:people="people"
				:selection="isWide || chosen ? selection : null"
				:page-href="pageHref"
				:topic-href="topicHref"
				:is-loading="isLoading"
				:error="error"
				@open-rail="railOpen = true"
				@retry="refetch"
			/>
		</div>

		<main
			ref="mainEl"
			class="min-w-0 flex-1 flex-col bg-bg-base lg:flex"
			:class="isDetailOpen ? 'flex' : 'hidden'"
			:aria-label="backLabel"
		>
			<template v-if="activeMessageId">
				<!-- Below lg the column, with its own way back, is hidden. -->
				<button
					type="button"
					class="flex min-h-11 items-center gap-1 border-b border-border-subtle px-3 text-caption text-text-secondary hover:text-text-primary lg:hidden"
					@click="backToPage"
				>
					<ChevronLeftIcon class="h-3.5 w-3.5" />
					{{ backLabel }}
				</button>
				<PostboxReaderPane
					class="@container min-h-0 flex-1 overflow-auto bg-bg-base"
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
					@back="backToPage"
				/>
			</template>
			<div v-else class="min-h-0 flex-1 overflow-y-auto">
				<button
					v-if="chosen"
					type="button"
					class="ml-3 mt-1 inline-flex min-h-11 items-center gap-1 rounded px-2 text-caption text-text-secondary hover:bg-bg-surface lg:hidden"
					@click="backToColumn"
				>
					<ChevronLeftIcon class="h-3.5 w-3.5" />
					{{ t('components.postbox.people.column.inbox') }}
				</button>
				<Transition name="pbx-fade" mode="out-in">
					<PostboxPersonPage
						v-if="person"
						ref="pageRef"
						:key="`person:${person.key}`"
						:person="person"
						:mailbox-id="mailboxId"
						:topics="topics"
						:company="person.companyKey ? companies.get(person.companyKey) : undefined"
						:names="names"
						:is-shared="isShared"
						:page-href="pageHref"
						:topic-href="hrefForTopic"
					/>
					<PostboxCompanyPage
						v-else-if="company"
						ref="pageRef"
						:key="`company:${company.key}`"
						:company="company"
						:mailbox-id="mailboxId"
						:topics="topics"
						:people="people"
						:accounts="accounts"
						:names="names"
						:is-shared="isShared"
						:page-href="pageHref"
						:topic-href="hrefForTopic"
					/>
					<div v-else-if="directory && !isLoading" class="mx-auto max-w-md px-6 py-24">
						<UiEmptyState
							:title="
								chosen
									? t('components.postbox.people.page.gone')
									: t('components.postbox.people.page.emptyTitle')
							"
							:description="
								chosen ? undefined : t('components.postbox.people.page.emptyDescription')
							"
						/>
					</div>
				</Transition>
			</div>
		</main>

		<PostboxShortcutHelp />
	</div>
</template>
