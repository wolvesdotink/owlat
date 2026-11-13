/**
 * A Team Inbox thread's messages, a page at a time (`inbox.threadPage`): the
 * newest page live, older pages on request, merged into one list, oldest
 * first. The messages waiting on a person (a draft to review, the agent's
 * questions) come with the first page wherever they sit in the history, so
 * the reply target never depends on how far back the reader has scrolled.
 *
 * `withBodies` asks the pages for opened bodies, for a surface that shows
 * every loaded message open (the thread page). Without it a message is an
 * envelope and `useTeamMessageBody` reads its body when it is expanded.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';

type ThreadPage = NonNullable<FunctionReturnType<typeof api.inbox.threadPage.getThreadPage>>;
type ThreadHead = NonNullable<ThreadPage['head']>;
/** A message as a page returns it: opened, or an envelope (`isBodyDeferred`). */
export type TeamThreadMessage = ThreadPage['messages'][number] | ThreadHead['waiting'][number];
export type TeamThreadContact = ThreadHead['contact'];

export function useTeamThreadMessages(
	threadId: Ref<Id<'conversationThreads'>>,
	opts: { withBodies: boolean }
) {
	const first = useConvexQuery(api.inbox.threadPage.getThreadPage, () => ({
		threadId: threadId.value,
		withBodies: opts.withBodies,
	}));

	// How many older pages were asked for; each follows the cursor of the one before.
	const requested = ref(0);
	watch(threadId, () => {
		requested.value = 0;
	});
	// The page map is created after the cursor chain that keys it, so it lives
	// in a ref: setting it re-runs the chain (the useTeamStream pattern).
	type PageMap = Map<string, { data: Ref<unknown> }>;
	const older = shallowRef<PageMap | null>(null);
	const pageOf = (cursor: string) =>
		older.value?.get(cursor)?.data.value as ThreadPage | null | undefined;
	const cursors = computed(() => {
		const out: string[] = [];
		let page = first.data.value;
		while (page && !page.isDone && out.length < requested.value) {
			out.push(page.cursor);
			page = pageOf(page.cursor);
		}
		return out;
	});
	older.value = useConvexQueryMap(api.inbox.threadPage.getThreadPage, cursors, (cursor) => ({
		threadId: threadId.value,
		withBodies: opts.withBodies,
		cursor,
	}));

	const loaded = computed(() => [first.data.value, ...cursors.value.map(pageOf)]);
	const head = computed(() => first.data.value?.head ?? null);
	const messages = computed<TeamThreadMessage[]>(() => {
		const byId = new Map<string, TeamThreadMessage>();
		for (const message of head.value?.waiting ?? []) byId.set(message._id, message);
		// A page's copy wins over the waiting list's: both are live, and the page
		// is what the stream shows.
		for (const page of loaded.value) {
			for (const message of page?.messages ?? []) byId.set(message._id, message);
		}
		return [...byId.values()].sort((a, b) => a._creationTime - b._creationTime);
	});

	const oldestLoaded = computed(() => loaded.value.at(-1));
	const hasEarlier = computed(() => {
		const page = oldestLoaded.value;
		return !!page && !page.isDone;
	});
	const isLoadingEarlier = computed(() => oldestLoaded.value === undefined && requested.value > 0);

	function loadEarlier() {
		if (!hasEarlier.value || isLoadingEarlier.value) return;
		requested.value = cursors.value.length + 1;
	}

	/**
	 * Keep loading older pages until every id `ids` names is loaded or the
	 * history ends: the stream's emails and a message picked by link need their
	 * rows, and they are as far back as the reader has gone, no further.
	 */
	function cover(ids: () => readonly string[]) {
		watch(
			[ids, messages, hasEarlier, isLoadingEarlier],
			() => {
				if (!hasEarlier.value || isLoadingEarlier.value) return;
				const have = new Set(messages.value.map((m) => m._id as string));
				if (ids().some((id) => !have.has(id))) loadEarlier();
			},
			{ immediate: true }
		);
	}

	return {
		/** Null once read: the thread is gone or the viewer may not read it. */
		isMissing: computed(() => first.data.value === null),
		head,
		messages,
		isLoading: first.isLoading,
		error: first.error,
		refetch: first.refetch,
		hasEarlier,
		isLoadingEarlier,
		loadEarlier,
		cover,
	};
}

/**
 * The message with its body: as given when it already carries one, else read
 * through `inbox.threadPage.getMessage` (null while that read is in flight).
 */
export function useTeamMessageBody(message: () => TeamThreadMessage) {
	const isDeferred = computed(() => {
		const m = message();
		return 'isBodyDeferred' in m && m.isBodyDeferred === true;
	});
	const { data } = useConvexQuery(api.inbox.threadPage.getMessage, () =>
		isDeferred.value ? { messageId: message()._id } : ('skip' as const)
	);
	return computed<TeamThreadMessage | null>(() => {
		const m = message();
		if (!isDeferred.value) return m;
		const full = data.value;
		return full && full._id === m._id ? full : null;
	});
}
