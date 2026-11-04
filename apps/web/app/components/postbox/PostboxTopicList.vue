<script setup lang="ts">
/**
 * A page's Earlier list: conversations that are no longer current, one quiet
 * row each, grouped by month for the past year and by year before that.
 * "Show older conversations" pages back past the directory's window through
 * the sender index (`mail/people/directory.ts earlierTopics`) until nothing
 * older is left, and "Search all mail" opens the full search for what the
 * index cannot see (a conversation they never wrote back in).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { PaperclipIcon, SparkleIcon, ChevronDownIcon, SearchIcon } from '@coolicons/vue';
import { mergeEarlier, previewText, topicPeriods, type PeopleTopic } from '~/utils/postboxPeople';
import {
	olderTopicsKey,
	usePostboxOlderTopics,
	type OlderTopics,
} from '~/composables/postbox/usePostboxPeople';

const props = defineProps<{
	topics: readonly PeopleTopic[];
	hrefFor: (topic: PeopleTopic) => string;
	mailboxId: Id<'mailboxes'>;
	/** The address older conversations are looked up for; none for a company. */
	olderFor?: string;
	/** The full search that covers what this list cannot. */
	searchHref?: string;
	/** A tag per topic (the person it was with, on a company page). */
	tagFor?: (topic: PeopleTopic) => string | undefined;
	/** "Show older emails" for a system sender, whose mail is no conversation. */
	olderLabel?: string;
	/** Whose mail the search link opens ("Search all mail with Lena"). */
	searchLabel?: string;
	/** Topics the page already shows elsewhere (its current ones): older pages skip them. */
	shownElsewhere?: readonly string[];
	/** A line of each mail's words under its title: for a sender's updates, where the subject alone says little. */
	withSnippet?: boolean;
}>();

const { t, locale } = useI18n();
const INITIAL = 12;
// Loaded pages and the unfolded state live in a store shared with the layout
// (usePostboxOlderTopics), so they outlive this list; a list without an
// address to page keeps its own.
const store = usePostboxOlderTopics();
const key = computed(() =>
	props.olderFor ? olderTopicsKey(props.mailboxId, props.olderFor) : null
);
const local = ref<OlderTopics>(emptyOlder());
function emptyOlder(): OlderTopics {
	return { topics: [], cursor: null, next: null, isAsked: false, isDone: false, isExpanded: false };
}
const state = computed<OlderTopics>(() =>
	key.value ? (store.value[key.value] ?? emptyOlder()) : local.value
);
function update(patch: Partial<OlderTopics>) {
	if (!key.value) {
		local.value = { ...local.value, ...patch };
		return;
	}
	store.value = { ...store.value, [key.value]: { ...state.value, ...patch } };
}
const isExpanded = computed(() => state.value.isExpanded);
const older = computed(() => state.value.topics);
const isOlderDone = computed(() => state.value.isDone);
const isOlderAsked = computed(() => state.value.isAsked);

// Older pages through the sender index, a cursor at a time; "Nothing older"
// only once the server says the address has no older mail.
const { data: olderPage, isLoading: isOlderLoading } = useConvexQuery(
	api.mail.people.directory.earlierTopics,
	() =>
		state.value.isAsked && props.olderFor
			? { mailboxId: props.mailboxId, email: props.olderFor, cursor: state.value.cursor }
			: 'skip'
);
watch(olderPage, (page) => {
	if (!page) return;
	// A page re-runs when its topics change (a rename, a reset): refreshed
	// records replace the cached ones by id, new ones are added.
	const fresh = new Map(page.topics.map((x) => [x.id, x]));
	const kept = older.value.map((x) => fresh.get(x.id) ?? x);
	const known = new Set([...props.topics, ...kept].map((x) => x.id));
	update({
		topics: [...kept, ...page.topics.filter((x) => !known.has(x.id))],
		next: page.continueCursor,
		isDone: page.isDone,
	});
});
function showOlder() {
	if (!state.value.isAsked) update({ isExpanded: true, isAsked: true });
	else if (state.value.next) update({ isExpanded: true, cursor: state.value.next });
}
function expand() {
	update({ isExpanded: true });
}

const all = computed(() => mergeEarlier(props.topics, older.value, props.shownElsewhere ?? []));
const shown = computed(() => (isExpanded.value ? all.value : all.value.slice(0, INITIAL)));
const hidden = computed(() => all.value.length - shown.value.length);
const periods = computed(() => topicPeriods(shown.value, new Date(), locale.value));
// A tag every row carries says nothing: the section heading already does.
const showTags = computed(
	() => new Set(all.value.map((topic) => props.tagFor?.(topic) ?? '')).size > 1
);
const shortDate = (at: number) =>
	new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'short' }).format(at);
const range = (topic: PeopleTopic) => {
	const end = shortDate(topic.lastMessageAt);
	const start = shortDate(topic.firstMessageAt);
	return start === end ? end : `${start} – ${end}`;
};
</script>

<template>
	<div>
		<!-- Nothing loaded yet: one quiet line and the ways further back as real
		     buttons, not an empty section. "Nothing older" only once the cursor is spent. -->
		<div v-if="all.length === 0" class="pt-2">
			<p class="text-sm text-text-tertiary">
				{{
					olderFor && !isOlderDone
						? t('components.postbox.people.earlier.noneRecent')
						: t('components.postbox.people.earlier.none')
				}}
			</p>
			<div
				v-if="(olderFor && !isOlderDone) || searchHref"
				class="mt-3 flex flex-wrap items-center gap-2"
			>
				<UiButton
					v-if="olderFor && !isOlderDone"
					variant="secondary"
					size="sm"
					:loading="isOlderAsked && isOlderLoading"
					@click="showOlder"
				>
					<ChevronDownIcon class="h-3.5 w-3.5" />
					{{ olderLabel ?? t('components.postbox.people.earlier.older') }}
				</UiButton>
				<UiButton v-if="searchHref" variant="secondary" size="sm" :to="searchHref">
					<SearchIcon class="h-3.5 w-3.5" />
					{{ searchLabel ?? t('components.postbox.people.earlier.searchAll') }}
				</UiButton>
			</div>
		</div>
		<section v-for="period in periods" :key="period.key" :aria-label="period.label">
			<h4
				class="flex items-center gap-3 pt-4 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-text-tertiary after:h-px after:flex-1 after:bg-border-subtle"
			>
				{{ period.label }}
			</h4>
			<NuxtLink
				v-for="topic in period.topics"
				:key="topic.id"
				:to="hrefFor(topic)"
				data-topic-card
				class="-mx-2.5 flex flex-col gap-0.5 rounded-lg px-2.5 py-2 outline-none hover:bg-bg-surface focus-visible:ring-2 focus-visible:ring-brand/40 sm:grid sm:grid-cols-[1fr_auto_auto] sm:gap-4"
				:class="withSnippet ? 'sm:items-start' : 'sm:items-center'"
			>
				<span class="flex min-w-0 flex-col">
					<span class="flex min-w-0 items-center gap-2">
						<SparkleIcon
							v-if="topic.titleSource === 'ai'"
							class="h-3 w-3 flex-shrink-0 text-accent"
							:aria-label="t('components.postbox.people.topic.namedByOwlat')"
						/>
						<span
							class="truncate text-sm text-text-primary"
							:class="topic.unreadCount > 0 ? 'font-semibold' : ''"
							>{{ topic.title }}</span
						>
						<span
							v-if="showTags && tagFor?.(topic)"
							class="flex-shrink-0 rounded bg-bg-surface px-1.5 text-2xs leading-4 text-text-tertiary"
							>{{ tagFor(topic) }}</span
						>
					</span>
					<span v-if="withSnippet && topic.snippet" class="truncate text-xs text-text-secondary">{{
						previewText(topic.snippet)
					}}</span>
				</span>
				<span class="inline-flex items-center gap-1.5 text-xs tabular-nums text-text-tertiary">
					<PostboxPeopleMark
						:owed="topic.isAsk ? 1 : 0"
						:may-owe="topic.turn === 'you' && !topic.isAsk ? 1 : 0"
						:unread="topic.unreadCount"
						size="sm"
						class="sm:hidden"
					/>
					<PaperclipIcon v-if="topic.hasAttachments" class="h-3 w-3" />
					<template v-if="topic.messageCount > 1">{{
						t(
							'components.postbox.people.topic.messages',
							{ count: topic.messageCount },
							topic.messageCount
						)
					}}</template>
					<span class="sm:hidden"
						><template v-if="topic.messageCount > 1 || topic.hasAttachments">· </template
						>{{ shortDate(topic.lastMessageAt) }}</span
					>
				</span>
				<!-- The mark sits beside the date, where the other lists keep it. -->
				<span
					class="hidden w-32 items-center justify-end gap-2 text-xs tabular-nums text-text-tertiary sm:inline-flex"
				>
					<PostboxPeopleMark
						:owed="topic.isAsk ? 1 : 0"
						:may-owe="topic.turn === 'you' && !topic.isAsk ? 1 : 0"
						:unread="topic.unreadCount"
						size="sm"
					/>
					{{ range(topic) }}
				</span>
			</NuxtLink>
		</section>
		<div v-if="all.length > 0" class="mt-3 flex flex-wrap items-center gap-2">
			<UiButton v-if="hidden > 0" variant="secondary" size="sm" @click="expand">
				<ChevronDownIcon class="h-3.5 w-3.5" />
				{{ t('components.postbox.people.earlier.showMore', { count: hidden }, hidden) }}
			</UiButton>
			<UiButton
				v-else-if="olderFor && !isOlderDone"
				variant="secondary"
				size="sm"
				:loading="isOlderAsked && isOlderLoading"
				@click="showOlder"
			>
				<ChevronDownIcon class="h-3.5 w-3.5" />
				{{ olderLabel ?? t('components.postbox.people.earlier.older') }}
			</UiButton>
			<span v-else-if="olderFor && isOlderDone" class="text-xs text-text-tertiary">{{
				t('components.postbox.people.earlier.nothingOlder')
			}}</span>
			<UiButton v-if="searchHref" variant="secondary" size="sm" :to="searchHref">
				<SearchIcon class="h-3.5 w-3.5" />
				{{ searchLabel ?? t('components.postbox.people.earlier.searchAll') }}
			</UiButton>
		</div>
	</div>
</template>
