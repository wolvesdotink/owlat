/**
 * The open conversation, paged (plan 3.3).
 *
 * The reader used to subscribe the whole thread with every body, so a
 * 200-message thread shipped 200 bodies to show the newest few. It now reads
 * the newest page (see `postboxThreadPage.ts`): the newest messages with
 * bodies, the older ones of the page as envelopes. Earlier pages load on
 * "Load earlier", or by themselves while the message the reader was opened on
 * is not among the loaded ones. An envelope's body loads once it is expanded
 * ({@link usePostboxEnvelopeBodies}).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';
import {
	THREAD_ANCHOR_PAGE_LIMIT,
	earlierThreadPageArgs,
	mergeThreadPages,
	threadPageArgs,
} from './postboxThreadPage';
import { rowCarriesBody, withInlineBody, type OpenRowMessage } from './usePostboxReaderOpenRow';

type ThreadPage = NonNullable<
	FunctionReturnType<typeof api.mail.mailbox.messages.listThreadMessages>
>;
/** An envelope, with its body folded in once it has been expanded. */
type EnvelopeRow = ThreadPage['envelopes'][number] & OpenRowMessage;
/** One message of the open thread: a row with its body, or an envelope. */
type PostboxThreadRow = ThreadPage['messages'][number] | EnvelopeRow;

export function usePostboxThreadPages(source: {
	/** The message the reader was opened on; the thread is read through it. */
	messageId: () => string;
	/** Identity of the open thread; a change drops the earlier pages. */
	threadKey: () => string;
}) {
	const newest = useConvexQuery(api.mail.mailbox.messages.listThreadMessages, () =>
		threadPageArgs(source.messageId())
	);

	/** Earlier pages asked for, beyond the newest one. */
	const earlierCount = ref(0);
	const earlierKeys = computed(() =>
		Array.from({ length: earlierCount.value }, (_, i) => String(i + 1))
	);
	// The newest page is not pinned to a cursor, so a new reply moves its
	// cursor and every earlier page re-reads from the new one. The rows each
	// page last delivered stay on screen until then.
	let lastDelivered = new Map<number, ThreadPage>();
	const earlier = useConvexQueryMap(
		api.mail.mailbox.messages.listThreadMessages,
		earlierKeys,
		(key) => {
			const cursor = pageAt(Number(key) - 1)?.olderCursor;
			return cursor ? earlierThreadPageArgs(source.messageId(), cursor) : 'skip';
		}
	);

	function pageAt(index: number): ThreadPage | undefined {
		if (index === 0) return newest.data.value ?? undefined;
		const data = earlier.get(String(index))?.data.value;
		if (data) {
			lastDelivered.set(index, data);
			return data;
		}
		return lastDelivered.get(index);
	}

	/** The loaded pages, newest first, up to the first one still loading. */
	const pages = computed(() => {
		const out: ThreadPage[] = [];
		for (let i = 0; i <= earlierCount.value; i++) {
			const page = pageAt(i);
			if (!page) break;
			out.push(page);
		}
		return out;
	});
	const allAskedLoaded = computed(() => pages.value.length === earlierCount.value + 1);
	/** The page after the loaded ones failed; "Load earlier" retries it. */
	const earlierFailed = computed(() => {
		if (pages.value.length === 0 || allAskedLoaded.value) return false;
		return (earlier.get(String(pages.value.length))?.error.value ?? null) !== null;
	});
	const loadingEarlier = computed(
		() => pages.value.length > 0 && !allAskedLoaded.value && !earlierFailed.value
	);
	/** The thread goes back further than the loaded pages. */
	const hasEarlier = computed(
		() => allAskedLoaded.value && !!pages.value[pages.value.length - 1]?.olderCursor
	);

	/** Every loaded message, oldest first; undefined until the newest page answers. */
	const rows = computed<PostboxThreadRow[] | undefined>(() =>
		pages.value.length > 0 ? mergeThreadPages<PostboxThreadRow>(pages.value) : undefined
	);
	/** The newest page alone: what the reader's default expanded set is built from. */
	const newestRows = computed<PostboxThreadRow[] | undefined>(() => {
		const page = newest.data.value;
		return page ? [...page.envelopes, ...page.messages] : undefined;
	});
	/** Ids of the rows that came with their bodies. */
	const bodyIds = computed(() => new Set((newest.data.value?.messages ?? []).map((m) => m._id)));

	/** An unread message is loaded, or the unloaded part of the thread has one. */
	const hasUnread = computed(
		() =>
			(rows.value ?? []).some((m) => !m.flagSeen) ||
			(hasEarlier.value && (newest.data.value?.thread?.unreadCount ?? 0) > 0)
	);

	function loadEarlier() {
		if (earlierFailed.value) {
			earlier.get(String(pages.value.length))?.refetch();
			return;
		}
		if (hasEarlier.value) earlierCount.value++;
	}

	// Opened on a message the loaded pages do not reach (a search hit deep in a
	// long thread): walk back to it, a bounded number of pages.
	watch(
		[rows, hasEarlier, source.messageId],
		([list, more, anchor]) => {
			if (!list || !more || list.some((row) => row._id === anchor)) return;
			if (earlierCount.value < THREAD_ANCHOR_PAGE_LIMIT) earlierCount.value++;
		},
		{ immediate: true }
	);

	watch(source.threadKey, () => {
		earlierCount.value = 0;
		lastDelivered = new Map();
	});

	return {
		/** The newest page's query: the thread doc, its labels, its loading state. */
		newest,
		rows,
		newestRows,
		bodyIds,
		hasUnread,
		hasEarlier,
		loadingEarlier,
		earlierFailed,
		/** The newest page reaches the thread's first message. */
		startsThread: computed(() => newest.data.value?.olderCursor === null),
		loadEarlier,
	};
}

/**
 * The rows with the bodies of expanded envelopes folded in. An envelope's body
 * loads through `getMessageInlineBody` once it is expanded, pending until it
 * answers (a body stored as a blob downloads from there, as for the opened
 * row). Collapsing it again releases the query.
 */
export function usePostboxEnvelopeBodies<Row extends OpenRowMessage>(source: {
	rows: () => readonly Row[] | undefined;
	expanded: () => ReadonlySet<string>;
	/** Rows that came with their bodies and need no body query. */
	bodyIds: () => ReadonlySet<string>;
}) {
	const wanted = computed(() =>
		(source.rows() ?? [])
			.filter(
				(row) =>
					source.expanded().has(row._id) && !source.bodyIds().has(row._id) && !rowCarriesBody(row)
			)
			.map((row) => row._id)
	);
	const bodies = useConvexQueryMap(
		api.mail.mailbox.messages.getMessageInlineBody,
		wanted,
		(id) => ({ messageId: id as Id<'mailMessages'> })
	);
	return computed(() =>
		source.rows()?.map((row) => {
			const body = bodies.get(row._id);
			return body ? withInlineBody(row, body.data.value, body.error.value !== null) : row;
		})
	);
}
