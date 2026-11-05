/**
 * The conversation view's data: the live directory read, lookups by key, the
 * place the route names, and the topic-title requests for what is on screen.
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
import { indexDirectory, parseFocus, type Focus } from '~/utils/postboxConversations';
import {
	selectionFromQuery,
	selectionQuery,
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
	const index = computed(() => (directory.value ? indexDirectory(directory.value) : null));
	return { directory, index, isLoading, error, refetch };
}

/** The inbox's own place in the URL: the Updates tab, or a page and how it is narrowed. */
export interface PeoplePlace {
	view: 'people' | 'updates';
	selection: PeopleSelection | null;
	focus: Focus;
	/** A company page narrowed to one of its people or departments. */
	member: string | null;
	/** Updates narrowed to one company. */
	from: string | null;
}

function placeQuery(place: Partial<PeoplePlace>): Record<string, string> {
	return {
		...(place.view === 'updates' ? { view: 'updates' } : {}),
		...(place.selection ? selectionQuery(place.selection) : {}),
		...(place.focus && place.focus !== 'all' ? { focus: place.focus } : {}),
		...(place.member ? { member: place.member } : {}),
		...(place.from ? { from: place.from } : {}),
	};
}

export function placeSearch(place: Partial<PeoplePlace>): string {
	const params = new URLSearchParams(placeQuery(place)).toString();
	return params ? `?${params}` : '';
}

/** The place the URL names, and the links between places and conversations. */
export function usePostboxPeopleRoute() {
	const route = useRoute();
	const place = computed<PeoplePlace>(() => {
		const one = (key: string) => {
			const value = route.query[key];
			return typeof value === 'string' && value ? value : null;
		};
		return {
			view: one('view') === 'updates' ? 'updates' : 'people',
			selection: selectionFromQuery(route.query),
			focus: parseFocus(one('focus')),
			member: one('member'),
			from: one('from'),
		};
	});
	const selection = computed(() => place.value.selection);

	/** A page, optionally narrowed. */
	function pageHref(
		target: PeopleSelection,
		narrow: { focus?: Focus; member?: string | null } = {}
	): string {
		return `/dashboard/postbox/inbox${placeSearch({ selection: target, ...narrow })}`;
	}

	/** The Updates tab, optionally one company's. */
	function updatesHref(from: string | null = null): string {
		return `/dashboard/postbox/inbox${placeSearch({ view: 'updates', from })}`;
	}

	/** A conversation, keeping the place it was opened from for Back. */
	function topicHref(topic: PeopleTopic, from: Partial<PeoplePlace> | null): string {
		if (!topic.latestMessageId) return '';
		return `/dashboard/postbox/inbox/${topic.latestMessageId}${placeSearch(from ?? {})}`;
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

	/** From a conversation back to the place it was opened from. */
	function backToPlace() {
		goUp(`/dashboard/postbox/inbox${placeSearch(place.value)}`);
	}

	/** From a page back to the list, which is all there is on a phone. */
	function backToList() {
		goUp(
			place.value.view === 'updates' ? updatesHref(place.value.from) : '/dashboard/postbox/inbox'
		);
	}

	return { place, selection, pageHref, updatesHref, topicHref, backToPlace, backToList };
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

/**
 * The mailbox's live drafts, newest edit first, and the reply draft each
 * conversation holds: one read for the pane's Drafts row and the "Draft
 * reply" cue on a conversation.
 */
export function usePostboxDrafts(mailboxId: Ref<Id<'mailboxes'>>) {
	const { data } = useConvexQuery(api.mail.drafts.listForMailbox, () => ({
		mailboxId: mailboxId.value,
	}));
	const drafts = computed(() => data.value ?? []);
	const byThread = computed(() => {
		const map = new Map<string, (typeof drafts.value)[number]>();
		for (const draft of drafts.value) {
			if (draft.threadId && !map.has(draft.threadId)) map.set(draft.threadId, draft);
		}
		return map;
	});
	return { drafts, byThread };
}

/** Calls one Done or Reopen may make before it gives up on a huge conversation. */
const DONE_CALLS_MAX = 50;

/**
 * Done and Reopen for one conversation. Done is archive underneath (every
 * Inbox message of it, a page per call, through `threadArchive.archiveThreads`)
 * plus the done mark (`mail/people/done.ts`), which also covers a
 * conversation with nothing in the Inbox. Undo reopens it.
 */
export function usePostboxDone() {
	const { t } = useI18n();
	const label = () => t('components.postbox.conversations.done.action');
	const archiveOp = useBackendOperation(api.mail.threadArchive.archiveThreads, { label });
	const markOp = useBackendOperation(api.mail.people.done.markDone, { label });
	const reopenOp = useBackendOperation(api.mail.people.done.reopen, {
		label: () => t('components.postbox.conversations.done.reopen'),
	});
	const triageUndo = usePostboxTriageUndo();

	async function reopen(threadId: Id<'mailThreads'>): Promise<boolean> {
		for (let call = 0; call < DONE_CALLS_MAX; call++) {
			const result = await reopenOp.run({ threadId });
			if (!result.ok) return false;
			if (!result.result?.hasMore) return true;
		}
		return true;
	}

	async function markDone(topic: PeopleTopic): Promise<boolean> {
		const threadId = topic.id as Id<'mailThreads'>;
		let cursor: string | null = null;
		for (let call = 0; call < DONE_CALLS_MAX; call++) {
			const result = await archiveOp.run({
				threads: [{ threadId, ...(cursor ? { cursor } : {}) }],
			});
			if (!result.ok) return false;
			const outcome = result.result?.threads[0];
			if (!outcome || outcome.isDone) break;
			cursor = outcome.cursor;
		}
		if (!(await markOp.run({ threadId })).ok) return false;
		triageUndo.register({
			label: t('components.postbox.conversations.done.marked', { title: topic.title }),
			inverse: async () => {
				await reopen(threadId);
			},
		});
		return true;
	}

	return { markDone, reopen };
}
