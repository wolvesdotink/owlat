<script setup lang="ts">
/**
 * The conversation view's pane: the mailbox header, unsent drafts, Updates,
 * then the people you have something open with (newest first; a company
 * holds its people and departments under a chevron, a group conversation is
 * a row of its own). Done conversations leave the list; search finds them,
 * labelled, and Enter searches all mail. Updates opens as a feed in the same
 * pane. `/` focuses the search, and j/k or the arrows walk the rows.
 */
import type { Id } from '@owlat/api/dataModel';
import { ChevronLeftIcon, SearchIcon } from '@coolicons/vue';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { ShortcutScope } from '~/utils/shortcutRegistry';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import { resolveActiveChord } from '~/utils/shortcutScope';
import {
	groupName,
	paneRows,
	replyNames,
	updateTopics,
	type DirectoryIndex,
	type Focus,
	type PaneDraft,
	type PaneRow,
} from '~/utils/postboxConversations';
import type { PeopleSelection, PeopleTopic } from '~/utils/postboxPeople';
import type { PeoplePlace } from '~/composables/postbox/usePostboxPeople';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	index: DirectoryIndex | null;
	place: PeoplePlace;
	/** The open conversation's thread, for the row it belongs to. */
	activeTopicId: string | null;
	pageHref: (target: PeopleSelection, narrow?: { focus?: Focus; member?: string | null }) => string;
	updatesHref: (from?: string | null) => string;
	topicHref: (topic: PeopleTopic) => string;
	drafts: readonly PaneDraft[];
	isLoading: boolean;
	error: Error | null;
}>();
const emit = defineEmits<{ retry: [] }>();

const { t } = useI18n();
const query = ref('');
const listEl = ref<HTMLElement | null>(null);

const isShared = computed(() => props.index?.directory.scope === 'shared');
const rows = computed<PaneRow[]>(() => (props.index ? paneRows(props.index, query.value) : []));
const isSearching = computed(() => query.value.trim().length > 0);

const waiting = computed(() =>
	props.index
		? replyNames(props.index).map((person) => ({
				key: person.key,
				name: person.name.trim().split(/\s+/)[0] ?? person.name,
				href: props.pageHref({ kind: 'person', key: person.key }, { focus: 'reply' }),
			}))
		: []
);
const updates = computed(() => (props.index ? updateTopics(props.index) : []));
const updatesUnread = computed(() => updates.value.filter((x) => x.unreadCount > 0).length);
const latestUpdate = computed(() => updates.value[0]);
const latestUpdateSender = computed(() => {
	const topic = latestUpdate.value;
	return topic
		? props.index?.accounts.get(topic.latestFromKey ?? topic.partyKeys[0] ?? '')
		: undefined;
});
const searchAllHref = computed(
	() => `/dashboard/postbox/search?q=${encodeURIComponent(query.value.trim())}`
);
function nameOf(address: string): string {
	const key = address.toLowerCase();
	return props.index?.people.get(key)?.name ?? props.index?.accounts.get(key)?.name ?? address;
}
const newTo = computed(() => {
	const selection = props.place.selection;
	return selection?.kind === 'person'
		? (props.index?.people.get(selection.key)?.email ?? null)
		: null;
});

// A company opens out when it, or one of its people, is what is open, and
// while a search matched it; otherwise it stays as the person left it.
const expanded = ref(new Set<string>());
function isExpanded(row: Extract<PaneRow, { kind: 'company' }>): boolean {
	if (isSearching.value || expanded.value.has(row.key)) return true;
	const selection = props.place.selection;
	return (
		!!selection && selection.kind === 'person' && row.members.some((m) => m.key === selection.key)
	);
}
function toggle(key: string, isOpen: boolean) {
	const next = new Set(expanded.value);
	if (isOpen) next.delete(key);
	else next.add(key);
	expanded.value = next;
}
const isSelected = (kind: PeopleSelection['kind'], key: string) =>
	props.place.selection?.kind === kind && props.place.selection.key === key;

const ROW_SCOPES: readonly ShortcutScope[] = ['postbox'];
function walk(event: KeyboardEvent, from: 'list' | 'search') {
	if (from === 'list' && isEditableTarget(event.target)) return;
	const id = resolveActiveChord(chordFromEvent(event), ROW_SCOPES);
	const step =
		event.key === 'ArrowDown' || (from === 'list' && id === 'postbox.next')
			? 1
			: event.key === 'ArrowUp' || (from === 'list' && id === 'postbox.previous')
				? -1
				: 0;
	const all = [...(listEl.value?.querySelectorAll<HTMLElement>('[data-pane-row]') ?? [])];
	if (step === 0 || all.length === 0) return;
	event.preventDefault();
	const at = all.indexOf(document.activeElement as HTMLElement);
	all[Math.min(all.length - 1, Math.max(0, at + step))]?.focus();
}
</script>

<template>
	<section
		class="flex h-full min-h-0 w-full flex-col bg-bg-elevated"
		:aria-label="t('components.postbox.conversations.pane.label')"
	>
		<PostboxPaneHeader
			v-model:query="query"
			:mailbox-id="mailboxId"
			:mailbox-address="index?.directory.mailboxAddress ?? null"
			:waiting="waiting"
			:new-to="newTo"
			@search-down="walk($event, 'search')"
		/>

		<div ref="listEl" class="min-h-0 flex-1 overflow-y-auto pb-6" @keydown="walk($event, 'list')">
			<div v-if="error && !index" class="px-4 py-10 text-center">
				<p class="text-sm text-text-secondary">
					{{ t('components.postbox.conversations.pane.error') }}
				</p>
				<UiButton class="mt-3" size="sm" variant="secondary" @click="emit('retry')">
					{{ t('components.postbox.conversations.pane.retry') }}
				</UiButton>
			</div>
			<div v-else-if="!index && isLoading" class="space-y-1 px-4 pt-2" aria-hidden="true">
				<UiSkeletonRow v-for="n in 8" :key="n" avatar avatar-size="h-9 w-9" :lines="2" trailing />
			</div>

			<template v-else-if="index && place.view === 'updates'">
				<NuxtLink
					to="/dashboard/postbox/inbox"
					class="mx-4 mb-1 inline-flex min-h-8 items-center gap-1 text-[0.8125rem] text-text-tertiary hover:text-text-primary"
				>
					<ChevronLeftIcon class="h-3.5 w-3.5" />
					{{ t('components.postbox.conversations.pane.backToConversations') }}
				</NuxtLink>
				<h2 class="px-4 text-lg font-semibold text-text-primary">
					{{ t('components.postbox.conversations.pane.updates') }}
				</h2>
				<PostboxUpdatesList
					:index="index"
					:query="query"
					:from="place.from"
					:active-topic-id="activeTopicId"
					:updates-href="updatesHref"
					:href-for="topicHref"
				/>
			</template>

			<template v-else-if="index">
				<template v-if="!isSearching">
					<PostboxPaneDrafts :mailbox-id="mailboxId" :drafts="drafts" :name-of="nameOf" />
					<NuxtLink
						:to="updatesHref()"
						data-pane-row
						class="flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-bg-surface-hover"
					>
						<PostboxPeopleAvatar
							kind="company"
							:name="latestUpdateSender?.name ?? t('components.postbox.conversations.pane.updates')"
							:logo-url="latestUpdateSender?.logoUrl"
							is-automated
							:sender-kind="latestUpdateSender?.kind ?? 'notification'"
						/>
						<span class="min-w-0 flex-1">
							<span class="flex items-baseline gap-2">
								<span
									class="flex-1 text-[0.9375rem] text-text-primary"
									:class="updatesUnread > 0 ? 'font-bold' : 'font-medium'"
									>{{ t('components.postbox.conversations.pane.updates')
									}}<span
										v-if="updatesUnread > 0"
										class="ml-1.5 text-xs font-semibold text-brand-muted"
										>{{ updatesUnread }}</span
									></span
								>
							</span>
							<span class="mt-0.5 block truncate text-[0.8125rem] text-text-secondary">
								<template v-if="latestUpdate"
									><span class="font-semibold"
										>{{ latestUpdateSender?.name ?? latestUpdate.title }}:</span
									>
									{{ latestUpdate.title }}</template
								>
								<template v-else>{{
									t('components.postbox.conversations.updates.empty')
								}}</template>
							</span>
						</span>
					</NuxtLink>
					<div class="mx-4 my-1 border-t border-border-subtle" />
				</template>
				<h3
					v-else
					class="px-4 pb-1 pt-2 text-[0.6875rem] font-bold uppercase tracking-[0.09em] text-text-tertiary"
				>
					{{ t('components.postbox.conversations.search.recent') }}
				</h3>
				<template v-for="row in rows" :key="`${row.kind}:${row.key}`">
					<PostboxPaneRow
						v-if="row.kind === 'person'"
						:href="pageHref({ kind: 'person', key: row.key })"
						:name="row.person.name"
						:mark="{ kind: 'person', name: row.person.name, colorKey: row.key }"
						:last-at="row.lastAt"
						:is-unread="row.isUnread"
						:line="row.line"
						:is-selected="isSelected('person', row.key)"
						:is-shared="isShared"
						:is-done="row.isDone"
					/>
					<template v-else-if="row.kind === 'company'">
						<PostboxPaneRow
							:href="pageHref({ kind: 'company', key: row.key })"
							:name="row.company.name"
							:mark="{
								kind: 'company',
								name: row.company.name,
								...(row.company.logoUrl ? { logoUrl: row.company.logoUrl } : {}),
							}"
							:last-at="row.lastAt"
							:is-unread="row.isUnread"
							:line="row.line"
							:is-selected="isSelected('company', row.key)"
							:is-shared="isShared"
							:is-done="row.isDone"
							:disclosure="isExpanded(row) ? 'open' : 'closed'"
							@toggle="toggle(row.key, isExpanded(row))"
						/>
						<template v-if="isExpanded(row)">
							<PostboxPaneRow
								v-for="member in row.members"
								:key="member.key"
								:href="
									member.kind === 'person'
										? pageHref({ kind: 'person', key: member.key })
										: pageHref({ kind: 'company', key: row.key }, { member: member.key })
								"
								:name="member.name"
								:mark="
									member.kind === 'person'
										? { kind: 'person', name: member.name, colorKey: member.key }
										: {
												kind: 'company',
												name: member.name,
												...(member.logoUrl ? { logoUrl: member.logoUrl } : {}),
											}
								"
								:last-at="member.lastAt"
								:is-unread="member.isUnread"
								:line="member.line"
								:is-selected="
									isSelected('person', member.key) ||
									(isSelected('company', row.key) && place.member === member.key)
								"
								:is-shared="isShared"
								is-nested
							/>
						</template>
					</template>
					<PostboxPaneRow
						v-else
						:href="topicHref(row.topic)"
						:name="groupName(row.members).names"
						:more="groupName(row.members).more"
						:mark="{
							kind: 'pair',
							first: { name: row.members[0]?.name ?? '', key: row.members[0]?.key ?? '' },
							second: { name: row.members[1]?.name ?? '', key: row.members[1]?.key ?? '' },
						}"
						:last-at="row.lastAt"
						:is-unread="row.isUnread"
						:line="row.line"
						:is-selected="activeTopicId === row.topic.id"
						:is-shared="isShared"
					/>
				</template>

				<NuxtLink
					v-if="isSearching"
					:to="searchAllHref"
					data-pane-row
					class="mx-2 mt-1 flex min-h-11 items-center gap-2 rounded-lg px-2 text-[0.8125rem] font-medium text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary"
				>
					<SearchIcon class="h-3.5 w-3.5" />
					{{ t('components.postbox.conversations.search.all', { query: query.trim() }) }}
				</NuxtLink>
				<div v-else-if="rows.length === 0" class="px-6 py-12 text-center">
					<p class="text-sm font-medium text-text-primary">
						{{ t('components.postbox.conversations.pane.emptyTitle') }}
					</p>
					<p class="mt-1 text-[0.8125rem] text-text-tertiary">
						{{ t('components.postbox.conversations.pane.emptyHint') }}
					</p>
				</div>
			</template>
		</div>
	</section>
</template>
