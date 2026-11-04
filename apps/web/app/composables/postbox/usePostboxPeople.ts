/**
 * The People view's data: the live directory read, lookups by key, the page
 * the route selects, and the topic-title requests for what is on screen.
 *
 * Titles are asked for lazily (`mail/people/topicTitle.ts requestTopicTitles`)
 * from here, for the topics a person can see, so a mailbox nobody opens in
 * this view never spends anything on them.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Ref } from 'vue';
import type { ShortcutScope } from '~/utils/shortcutRegistry';
import { chordFromEvent } from '~/utils/shortcutRegistry';
import { resolveActiveChord } from '~/utils/shortcutScope';
import {
	selectionFromQuery,
	selectionQuery,
	type PeopleCompany,
	type PeoplePerson,
	type PeopleSelection,
	type PeopleTopic,
} from '~/utils/postboxPeople';

/** Most topics one title request names; the server caps it too. */
const TITLE_BATCH = 40;

export function usePostboxPeopleDirectory(mailboxId: Ref<Id<'mailboxes'>>) {
	const { data, isLoading, error, refetch } = useConvexQuery(
		api.mail.people.directory.directory,
		() => ({ mailboxId: mailboxId.value }),
		{ keepPreviousData: true }
	);
	const directory = computed(() => data.value ?? null);
	const topics = computed(
		() => new Map<string, PeopleTopic>((directory.value?.topics ?? []).map((t) => [t.id, t]))
	);
	const people = computed(
		() => new Map<string, PeoplePerson>((directory.value?.people ?? []).map((p) => [p.key, p]))
	);
	const companies = computed(
		() => new Map<string, PeopleCompany>((directory.value?.companies ?? []).map((c) => [c.key, c]))
	);
	const accounts = computed(
		() => new Map((directory.value?.accounts ?? []).map((a) => [a.key, a] as const))
	);
	return { directory, topics, people, companies, accounts, isLoading, error, refetch };
}

/** The page the URL selects, and the moves between pages and topics. */
export function usePostboxPeopleRoute() {
	const route = useRoute();
	const selection = computed(() => selectionFromQuery(route.query));

	/** The URL of a page, keeping whatever else the inbox URL carries. */
	function pageHref(target: PeopleSelection): string {
		const params = new URLSearchParams(selectionQuery(target));
		return `/dashboard/postbox/inbox?${params.toString()}`;
	}

	/** The URL of a topic opened from a page: the reader, with the page kept for Back. */
	function topicHref(topic: PeopleTopic, from: PeopleSelection | null): string {
		if (!topic.latestMessageId) return '';
		const query = from ? `?${new URLSearchParams(selectionQuery(from)).toString()}` : '';
		return `/dashboard/postbox/inbox/${topic.latestMessageId}${query}`;
	}

	const router = useRouter();
	/**
	 * Go up a level. When the entry before this one is that level (it was
	 * opened from there), step back through history, so the browser's own Back
	 * does not land on the level twice; a deep link goes there with a replace.
	 */
	function goUp(href: string) {
		const previous = import.meta.client ? window.history.state?.back : null;
		// The router may spell `@` either way; compare what the paths mean.
		if (typeof previous === 'string' && decodeURIComponent(previous) === decodeURIComponent(href))
			router.back();
		else void navigateTo(href, { replace: true });
	}

	/** From the reader back to the page it was opened from. */
	function backToPage() {
		const from = selection.value;
		goUp(from ? pageHref(from) : '/dashboard/postbox/inbox');
	}

	/** From a page back to the column, which is all there is below `lg`. */
	function backToColumn() {
		goUp('/dashboard/postbox/inbox');
	}

	return { selection, pageHref, topicHref, backToPage, backToColumn };
}

/**
 * Ask for model titles of the topics a page or the column shows, once per
 * set: a re-render with the same topics asks nothing new.
 */
export function usePostboxTopicTitleRequests(
	mailboxId: Ref<Id<'mailboxes'>>,
	visible: Ref<readonly PeopleTopic[]>
) {
	// Background and best-effort: a refused or failed request leaves the
	// subjects standing in, which is nothing to tell anyone about.
	const op = useBackendOperation(api.mail.people.topicTitle.requestTopicTitles, {
		label: 'Name topics',
		announce: false,
		onError: () => true,
	});
	// Each topic is asked about again when its name was reset to the subject
	// or the conversation grew since it was last asked; the server decides
	// whether to write and keeps its own pending guard against repeats.
	const seen = new Map<string, { source: PeopleTopic['titleSource']; count: number }>();
	const wantsAsk = (t: PeopleTopic) => {
		const last = seen.get(t.id);
		if (!last) return true;
		if (t.titleSource === 'subject' && last.source !== 'subject') return true;
		return t.messageCount > last.count;
	};
	watch(
		() =>
			visible.value
				.filter((t) => t.titleSource !== 'user' && t.messageCount >= 2 && wantsAsk(t))
				.slice(0, TITLE_BATCH),
		(topics) => {
			for (const t of visible.value) {
				const last = seen.get(t.id);
				if (last) seen.set(t.id, { ...last, source: t.titleSource });
			}
			if (topics.length === 0) return;
			for (const t of topics) seen.set(t.id, { source: t.titleSource, count: t.messageCount });
			void op.run({
				mailboxId: mailboxId.value,
				threadIds: topics.map((t) => t.id) as Id<'mailThreads'>[],
			});
		},
		{ immediate: true }
	);
}

const WALK_SCOPES: readonly ShortcutScope[] = ['postbox'];

/**
 * The Postbox's next/previous keys (j/k and the arrows, remaps and presets
 * included) on a page walk its conversations (`[data-topic-card]`, a card or
 * an Earlier row), the way they walk the column's rows. Inert in a text field.
 */
export function walkTopicCards(event: KeyboardEvent) {
	const target = event.target as HTMLElement | null;
	if (target?.closest('input, textarea, [contenteditable="true"]')) return;
	const id = resolveActiveChord(chordFromEvent(event), WALK_SCOPES);
	const step = id === 'postbox.next' ? 1 : id === 'postbox.previous' ? -1 : 0;
	if (step === 0) return;
	const host = event.currentTarget as HTMLElement;
	const targets = [...host.querySelectorAll<HTMLElement>('[data-topic-card]')].map(
		(card) => (card.matches('a') ? card : card.querySelector<HTMLElement>('a')) ?? card
	);
	if (targets.length === 0) return;
	event.preventDefault();
	// From a card's own button, count from the card it sits in.
	const active = document.activeElement as HTMLElement | null;
	const card = active?.closest<HTMLElement>('[data-topic-card]');
	const from = card ? (card.matches('a') ? card : card.querySelector<HTMLElement>('a')) : active;
	const index = targets.indexOf(from as HTMLElement);
	targets[Math.min(targets.length - 1, Math.max(0, index + step))]?.focus();
}

/** One address's older conversations as far as they were loaded, with the cursor on. */
export interface OlderTopics {
	topics: PeopleTopic[];
	cursor: string | null;
	next: string | null;
	isAsked: boolean;
	isDone: boolean;
	isExpanded: boolean;
}

/**
 * Older conversations loaded through "Show older mail", per mailbox and
 * address, shared by the list that loads them and the layout that opens them:
 * an old conversation opens with its name and its place in the column, and a
 * page comes back with what was already loaded and unfolded.
 */
export function usePostboxOlderTopics() {
	return useState<Record<string, OlderTopics>>('postbox-people-older', () => ({}));
}

export function olderTopicsKey(mailboxId: string, email: string): string {
	return `${mailboxId}:${email.toLowerCase()}`;
}
