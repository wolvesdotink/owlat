<script setup lang="ts">
/**
 * The conversation view's pane: the mailbox header, then either the people
 * you write with (newest activity first; a company holds its people and
 * departments under a chevron, a group conversation is a row of its own) or
 * the Updates feed. Search narrows by name, address, company and topic; `/`
 * focuses it, and j/k or the arrows walk the rows.
 */
import type { Id } from '@owlat/api/dataModel';
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
	isLoading: boolean;
	error: Error | null;
}>();
const emit = defineEmits<{ 'open-folders': []; retry: [] }>();

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
const updatesUnread = computed(() =>
	props.index ? updateTopics(props.index).filter((x) => x.unreadCount > 0).length : 0
);
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
			:view="place.view"
			:updates-unread="updatesUnread"
			:waiting="waiting"
			:new-to="newTo"
			:people-href="'/dashboard/postbox/inbox'"
			:updates-href="updatesHref()"
			@open-folders="emit('open-folders')"
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

			<PostboxUpdatesList
				v-else-if="index && place.view === 'updates'"
				:index="index"
				:query="query"
				:from="place.from"
				:active-topic-id="activeTopicId"
				:updates-href="updatesHref"
				:href-for="topicHref"
			/>

			<template v-else-if="index">
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

				<div v-if="rows.length === 0" class="px-6 py-14 text-center">
					<p class="text-sm font-medium text-text-primary">
						{{
							isSearching
								? t('components.postbox.conversations.pane.noMatch')
								: t('components.postbox.conversations.pane.emptyTitle')
						}}
					</p>
					<p class="mt-1 text-[0.8125rem] text-text-tertiary">
						{{
							isSearching
								? t('components.postbox.conversations.pane.noMatchHint')
								: t('components.postbox.conversations.pane.emptyHint')
						}}
					</p>
				</div>
			</template>
		</div>
	</section>
</template>
