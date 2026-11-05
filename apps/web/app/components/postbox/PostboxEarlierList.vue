<script setup lang="ts">
/**
 * A page's Earlier conversations (archived or muted, and older mail past the
 * directory's window): one quiet line each,
 * topic and date. "Show more" first unfolds what the directory already holds,
 * then, for a person, reaches back through their older mail a page at a time
 * (`mail/people/directory.ts earlierTopics`). What it loaded is kept per
 * address (`usePostboxOlderTopics`), so a conversation opened from here keeps
 * its name and the page comes back as it was left.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	olderTopicsKey,
	usePostboxOlderTopics,
	type OlderTopics,
} from '~/composables/postbox/usePostboxPeople';
import type { PeopleTopic } from '~/utils/postboxPeople';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** Earlier conversations the directory holds, newest first. */
	topics: readonly PeopleTopic[];
	/** Everything the page shows above, kept out of what older pages repeat. */
	shownAbove: readonly string[];
	/** A person's address: older mail can be read for it. */
	olderFor: string | null;
	hrefFor: (topic: PeopleTopic) => string;
}>();

const { t, locale } = useI18n();
const INITIAL = 6;

const store = usePostboxOlderTopics();
const key = computed(() =>
	props.olderFor ? olderTopicsKey(props.mailboxId, props.olderFor) : null
);
const EMPTY: OlderTopics = {
	topics: [],
	cursor: null,
	next: null,
	isAsked: false,
	isDone: false,
	isExpanded: false,
};
const local = ref<OlderTopics>({ ...EMPTY });
const state = computed(() => (key.value ? (store.value[key.value] ?? EMPTY) : local.value));
function update(patch: Partial<OlderTopics>) {
	if (!key.value) local.value = { ...local.value, ...patch };
	else store.value = { ...store.value, [key.value]: { ...state.value, ...patch } };
}

const { data: page, isLoading } = useConvexQuery(api.mail.people.directory.earlierTopics, () =>
	state.value.isAsked && props.olderFor
		? { mailboxId: props.mailboxId, email: props.olderFor, cursor: state.value.cursor }
		: 'skip'
);
watch(page, (next) => {
	if (!next) return;
	// A page re-runs when its topics change (a rename): fresh records replace
	// the cached ones by id, new ones are added.
	const fresh = new Map(next.topics.map((x) => [x.id, x]));
	const kept = state.value.topics.map((x) => fresh.get(x.id) ?? x);
	const known = new Set(kept.map((x) => x.id));
	update({
		topics: [...kept, ...next.topics.filter((x) => !known.has(x.id))],
		next: next.continueCursor,
		isDone: next.isDone,
	});
});

// Older pages start from the newest mail, so they repeat what the page shows
// above and what is already here; those stay out. An unarchived conversation
// older than the directory reaches is listed here too: it has nowhere else.
const all = computed(() => {
	const known = new Set([...props.topics.map((x) => x.id), ...props.shownAbove]);
	return [...props.topics, ...state.value.topics.filter((x) => !known.has(x.id))].sort(
		(a, b) => b.lastMessageAt - a.lastMessageAt
	);
});
const shown = computed(() => (state.value.isExpanded ? all.value : all.value.slice(0, INITIAL)));
const canReachBack = computed(() => !!props.olderFor && !state.value.isDone);
const hasMore = computed(() => all.value.length > shown.value.length || canReachBack.value);

function showMore() {
	if (all.value.length > shown.value.length && !state.value.isExpanded) {
		update({ isExpanded: true });
	} else if (!state.value.isAsked) {
		update({ isExpanded: true, isAsked: true });
	} else if (state.value.next) {
		update({ isExpanded: true, cursor: state.value.next });
	}
}

const date = (at: number) =>
	new Intl.DateTimeFormat(locale.value, {
		day: 'numeric',
		month: 'short',
		...(new Date(at).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
	}).format(at);
</script>

<template>
	<section v-if="all.length > 0 || canReachBack">
		<h2 class="mb-1 mt-9 text-[0.6875rem] font-bold uppercase tracking-[0.09em] text-text-tertiary">
			{{ t('components.postbox.conversations.page.earlier') }}
		</h2>
		<ul>
			<li v-for="topic in shown" :key="topic.id" data-topic-card>
				<NuxtLink
					:to="hrefFor(topic)"
					class="-mx-2 flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary"
				>
					<span class="min-w-0 flex-1 truncate">{{ topic.title }}</span>
					<span class="flex-shrink-0 text-xs tabular-nums text-text-tertiary">{{
						date(topic.lastMessageAt)
					}}</span>
				</NuxtLink>
			</li>
		</ul>
		<button
			v-if="hasMore"
			type="button"
			class="-mx-2 mt-1 rounded-md px-2 py-1.5 text-sm text-text-tertiary hover:bg-bg-surface-hover hover:text-text-primary disabled:opacity-60"
			:disabled="state.isAsked && isLoading"
			@click="showMore"
		>
			{{
				all.length === 0
					? t('components.postbox.conversations.page.olderMail')
					: t('components.postbox.conversations.page.showMore')
			}}
		</button>
	</section>
</template>
