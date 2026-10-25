/**
 * Answer mode's shared state: where a reply came from and how to get back
 * there (or on, after a reply marked done), the draft someone walked away
 * from, the list position they left, and the "Draft with AI" focus hook
 * Cmd/Ctrl+J reaches for.
 *
 * All of it is session state (`useState` / module scope), never persisted: a
 * reload of the Answer mode route rebuilds itself from the URL, and a reload of
 * the list starts from the list's own URL.
 */
import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import {
	answerFallbackReturn,
	answerModeHref,
	answerTeamHref,
	isAnswerModePath,
	type AnswerModeKind,
} from '~/utils/answerMode';

declare module '#app' {
	interface PageMeta {
		/**
		 * Answer mode: the dashboard layout hides its sidebar and shell header,
		 * the same way it does for the email builder's focus mode, and Cmd/Ctrl+J
		 * stays with the page instead of opening the Assistant.
		 */
		answerMode?: boolean;
	}
}

/**
 * Open and leave Answer mode. `open` remembers the page it was opened from, so
 * Esc and "← Inbox" go back to exactly that page; `leave` walks back through
 * history when the previous entry IS that page (keeping the browser's own Back
 * in step) and replaces otherwise (a deep link, a reload, the desktop window).
 */
export function useAnswerModeNav(
	opts: {
		/**
		 * The host page's own route path (an Answer mode page passes its
		 * `route.path`): the back link's fallback is read from it, so the
		 * `returnPath` computed never reaches for the router itself.
		 */
		currentPath?: () => string;
	} = {}
) {
	const returnTo = useState<string | null>('answer:return-to', () => null);

	// The router is read when a verb runs, not at setup: most hosts of these
	// verbs (list rows, the reader, toasts) never open Answer mode at all.
	function go(href: string) {
		const current = useRouter().currentRoute.value;
		if (!isAnswerModePath(current.path)) {
			returnTo.value = current.fullPath;
			answerOrigin = null;
			markListReturn();
		}
		return navigateTo(href);
	}

	function open(
		messageId: string,
		opts: { kind?: AnswerModeKind | null; draftId?: string | null } = {}
	) {
		return go(answerModeHref(messageId, opts));
	}

	/** Answer mode for a Team inbox thread (optionally on one of its messages). */
	function openTeam(threadId: string, opts: { messageId?: string | null } = {}) {
		return go(answerTeamHref(threadId, opts));
	}

	/** The recorded page, else the list the Answer mode route at `path` belongs to. */
	function returnTarget(path: string): string {
		return returnTo.value ?? answerFallbackReturn(path);
	}

	function leave() {
		const target = returnTarget(opts.currentPath?.() ?? useRouter().currentRoute.value.path);
		returnTo.value = null;
		answerOrigin = null;
		const back =
			typeof window === 'undefined'
				? undefined
				: (window.history.state?.back as string | null | undefined);
		if (back && back === target) {
			useRouter().back();
			return;
		}
		void navigateTo(target, { replace: true });
	}

	/**
	 * Leave after a reply that marked its conversation done: on to the next
	 * conversation of the list it was opened from, the way archiving moves on
	 * in the reader (`mode` is that auto-advance preference). Without such a
	 * list, the plain way back. `done` is the message replied to and its
	 * conversation, whose other rows the same send archives.
	 */
	function leaveDone(done: AnswerDone, mode: PostboxAutoAdvanceMode) {
		const target = answerDoneTarget(answerOrigin, done, mode);
		if (!target) return leave();
		returnTo.value = null;
		answerOrigin = null;
		void navigateTo(target, { replace: true });
	}

	/**
	 * The label of the back link: the page a reply returns to. Without the
	 * host's path the fallback is the Postbox inbox; only the Answer mode pages
	 * read this, and they pass their path.
	 */
	const returnPath = computed(() => returnTarget(opts.currentPath?.() ?? ''));

	/**
	 * Name the page Esc returns to, for a host that moves between Answer mode
	 * routes itself: the Answer queue steps from item to item with replaces, and
	 * leaving any of them leaves the queue for the page it was opened from.
	 */
	function setReturnPath(path: string) {
		returnTo.value = path;
	}

	return { open, openTeam, leave, leaveDone, returnPath, setReturnPath };
}

/** A reply draft left in Answer mode, offered back on the list ("Resume"). */
export interface AnswerLeftDraft {
	draftId: Id<'mailDrafts'>;
	messageId: string;
	mailboxId: string;
	kind: AnswerModeKind | null;
	/** Who the reply goes to, for "Draft to <name> saved". */
	recipient: string;
}

export function useAnswerLeftDraft() {
	const left = useState<AnswerLeftDraft | null>('answer:left-draft', () => null);
	return {
		left,
		set: (draft: AnswerLeftDraft) => {
			left.value = draft;
		},
		clear: () => {
			left.value = null;
		},
		/**
		 * Take the offer back only when it is for `draftId`: sending or
		 * discarding one reply must not drop the offer of another draft left
		 * earlier.
		 */
		clearFor: (draftId: string | null | undefined) => {
			if (draftId && left.value?.draftId === draftId) left.value = null;
		},
	};
}

/**
 * An AI-suggested reply body waiting for Answer mode to open on `messageId`.
 * Only used when the draft could not be created up front (the normal path
 * creates the draft with the body and opens it by id); Answer mode takes it
 * once, for that message.
 */
export function useAnswerPendingLead() {
	const pending = useState<{ messageId: string; text: string } | null>(
		'answer:pending-lead',
		() => null
	);
	return {
		set: (messageId: string, text: string) => {
			pending.value = { messageId, text };
		},
		take: (messageId: string): string | undefined => {
			const entry = pending.value;
			if (!entry || entry.messageId !== messageId) return undefined;
			pending.value = null;
			return entry.text;
		},
	};
}

// The list's place, kept across the round trip
// The folder list's scroll offset already survives a remount (the per-folder
// scroll memory in usePostboxVirtualList). What does not survive is the
// keyboard focus: the j/k row. The list files it here as it unmounts, and takes
// it back on the next mount only when that mount is the return from Answer mode
// (a later visit to the folder starts fresh, as it always did).

export interface ListReturnSnapshot {
	/** The row the j/k focus was on. */
	focusedId: string | null;
}

const listSnapshots = new Map<string, ListReturnSnapshot>();
let listReturnPending = false;

/** Called as Answer mode opens: the next list mount is a return. */
function markListReturn() {
	listReturnPending = true;
}

/**
 * Where a list Answer mode was opened from stood, so a reply marked done can
 * move on through it. Only a list that routes its own opens files one, only
 * the departure into Answer mode keeps it, and leaving Answer mode drops it: a
 * later reply never moves through a list it did not come from.
 */
export interface AnswerOrigin {
	/**
	 * The list's own route, where 'back-to-list' goes: a folder
	 * (`/dashboard/postbox/inbox`) or a label view (`/dashboard/postbox/label/…`).
	 */
	listPath: string;
	/**
	 * The route its rows open under (`${messagePath}/<id>`). Not always the
	 * list's: a label view opens its rows in the Inbox reader.
	 */
	messagePath: string;
	/** The list's query (`?placement=…`), kept on the route it moves to. */
	query: string;
	/** The rows in the order the list showed them, with their conversation. */
	rows: readonly AnswerOriginRow[];
	/** The conversation open beside the list, if any. */
	activeId: string | null;
}

export interface AnswerOriginRow {
	id: string;
	threadId: string | null;
}

/** The reply that marked its conversation done: the message it answered, and that conversation. */
export interface AnswerDone {
	messageId: string;
	threadId: string | null;
}

let answerOrigin: AnswerOrigin | null = null;

/**
 * The route a reply marked done moves on to: the nearest row of the list it
 * came from, per `mode`, that belongs to another conversation (the same send
 * archives every row of this one), or that list itself (no such row,
 * 'back-to-list', or the conversation is not a row of it). `null` without a
 * list: the caller goes back the plain way.
 */
export function answerDoneTarget(
	origin: AnswerOrigin | null,
	done: AnswerDone,
	mode: PostboxAutoAdvanceMode
): string | null {
	if (!origin) return null;
	const back = `${origin.listPath}${origin.query}`;
	if (mode === 'back-to-list') return back;
	const { rows } = origin;
	// Where the conversation stands in the list: the message replied to, another
	// message of its conversation, or (an older message answered) the row open
	// beside the list.
	let index = rows.findIndex((row) => row.id === done.messageId);
	if (index < 0 && done.threadId !== null)
		index = rows.findIndex((row) => row.threadId === done.threadId);
	if (index < 0 && origin.activeId !== null)
		index = rows.findIndex((row) => row.id === origin.activeId);
	if (index < 0) return back;
	const current = rows[index]!;
	const finished = new Set(
		[done.threadId, current.threadId].filter((id): id is string => id !== null)
	);
	const step = mode === 'next' ? 1 : -1;
	for (let i = index + step; i >= 0 && i < rows.length; i += step) {
		const row = rows[i]!;
		if (row.id === current.id || (row.threadId !== null && finished.has(row.threadId))) continue;
		return `${origin.messagePath}/${row.id}${origin.query}`;
	}
	return back;
}

/** The list files its place for `folderKey` (called on unmount). */
export function rememberListPlace(folderKey: string, snapshot: ListReturnSnapshot): void {
	listSnapshots.set(folderKey, snapshot);
}

/**
 * The place to restore for `folderKey`, once, and only when this mount is the
 * way back from Answer mode.
 */
export function takeListPlace(folderKey: string): ListReturnSnapshot | null {
	if (!listReturnPending) return null;
	listReturnPending = false;
	const snapshot = listSnapshots.get(folderKey) ?? null;
	listSnapshots.delete(folderKey);
	return snapshot;
}

/**
 * Files where a list stood as it unmounts on the way into Answer mode, so a
 * reply marked done moves on through it: `rows` in the order the list shows
 * them (collapsed sections and bundles left out), and `origin` (null: a list
 * that does not route its own opens). Every list renderer the Postbox can show
 * files through here; one that does not leaves a reply marked done from it
 * nowhere to move on to.
 */
export function useListAnswerOrigin(o: {
	rows: () => readonly AnswerOriginRow[];
	origin: () => Omit<AnswerOrigin, 'rows'> | null;
}) {
	onBeforeUnmount(() => {
		if (!listReturnPending) return;
		const origin = o.origin();
		if (origin) answerOrigin = { ...origin, rows: o.rows() };
	});
}

/** The origin of a list that is its folder's route and opens its rows under it. */
export function folderAnswerOrigin(
	folderSegment: string,
	activeId: string | null | undefined
): Omit<AnswerOrigin, 'rows'> {
	const path = `/dashboard/postbox/${folderSegment}`;
	return { listPath: path, messagePath: path, query: '', activeId: activeId ?? null };
}

/**
 * A list's side of the Answer mode round trip: its j/k row comes back with it
 * (the scroll offset has its own per-folder memory), and it files its origin
 * for a reply marked done ({@link useListAnswerOrigin}). The place is filed on
 * every unmount and taken only on the mount that is the way back.
 */
export function useListAnswerRoundTrip(o: {
	folderKey: Ref<string>;
	rows: Ref<readonly { _id: string; threadId?: string | null }[]>;
	focusedIndex: Ref<number>;
	origin: () => Omit<AnswerOrigin, 'rows'> | null;
}) {
	useListAnswerOrigin({
		rows: () => o.rows.value.map((row) => ({ id: row._id, threadId: row.threadId ?? null })),
		origin: o.origin,
	});
	onBeforeUnmount(() => {
		rememberListPlace(o.folderKey.value, {
			focusedId: o.rows.value[o.focusedIndex.value]?._id ?? null,
		});
	});
	const returnPlace = takeListPlace(o.folderKey.value);
	if (!returnPlace?.focusedId) return;
	const focusedId = returnPlace.focusedId;
	const stop = watch(
		o.rows,
		(rows) => {
			const index = rows.findIndex((row) => row._id === focusedId);
			if (index < 0) return;
			o.focusedIndex.value = index;
			void nextTick(() => stop());
		},
		{ immediate: true }
	);
}

// Cmd/Ctrl+J: "Draft with AI"
// Inside Answer mode the chord focuses the draft's own AI entry point instead
// of opening the Assistant (plan decision 6). The AI bar registers how to focus
// itself; the page asks. Nothing registered means the chord does nothing, which
// is still better than leaving the draft for another page.

let aiFocusHandler: (() => void) | null = null;

export function useAnswerAiFocus() {
	return {
		/** The AI bar: "this is how to focus me". Returns the unregister. */
		register(handler: () => void): () => void {
			aiFocusHandler = handler;
			return () => {
				if (aiFocusHandler === handler) aiFocusHandler = null;
			};
		},
		/** The page: focus "Draft with AI" if something is there to focus. */
		request(): boolean {
			if (!aiFocusHandler) return false;
			aiFocusHandler();
			return true;
		},
	};
}
