/**
 * Which messages of the open thread the reader shows expanded.
 *
 * The default set is computed once per thread, from the first loaded message
 * list: the latest message, the first one when the thread has more than two,
 * the last {@link MAX_AUTO_EXPANDED_UNREAD} unread messages and the active one.
 * After that the set only grows: a message that arrives later (a reply, a
 * sync) is added, nothing is taken away.
 *
 * The unread cap matters on long threads: every expanded message mounts an
 * iframe and runs the sanitize pipeline, so a 40-message unread thread used to
 * pay for 40 bodies before anything was readable. Older unread messages stay
 * one click away as collapsed rows.
 *
 * Rebuilding the set on every query update used to undo itself: the reader
 * marks the thread read on open, the query comes back with `flagSeen` set, and
 * the unread messages it had just expanded collapsed a round trip later. Any
 * live update also threw away the user's own expand/collapse clicks.
 */
import { ref, watch, type Ref } from 'vue';

export interface ReaderExpansionMessage {
	_id: string;
	flagSeen?: boolean;
}

/** How many unread messages, counted from the newest, open expanded. */
export const MAX_AUTO_EXPANDED_UNREAD = 3;

/** The default expanded set for a freshly opened thread. */
export function initialExpandedIds(
	messages: readonly ReaderExpansionMessage[],
	activeId: string
): Set<string> {
	const next = new Set<string>();
	const last = messages[messages.length - 1];
	if (last) next.add(last._id);
	const first = messages[0];
	if (messages.length > 2 && first) next.add(first._id);
	let unread = 0;
	for (let i = messages.length - 1; i >= 0 && unread < MAX_AUTO_EXPANDED_UNREAD; i--) {
		const m = messages[i];
		if (m && !m.flagSeen) {
			next.add(m._id);
			unread++;
		}
	}
	next.add(activeId);
	return next;
}

export interface PostboxReaderExpansionSource {
	/** Identity of the open thread; a change starts a fresh default set. */
	threadKey: () => string;
	/** The message the reader was opened on; always expanded. */
	activeId: () => string;
	/** The thread's loaded messages, or `undefined` while the query loads. */
	messages: () => readonly ReaderExpansionMessage[] | undefined;
}

export function usePostboxReaderExpansion(source: PostboxReaderExpansionSource): {
	expanded: Ref<Set<string>>;
	toggleExpanded: (id: string) => void;
} {
	const expanded = ref<Set<string>>(new Set());
	let threadKey: string | null = null;
	let activeId: string | null = null;
	// Ids seen in a loaded list of the current thread. `null` until the first
	// load, which is the one that builds the default set.
	let known: Set<string> | null = null;

	function addIds(ids: Iterable<string>) {
		let next: Set<string> | null = null;
		for (const id of ids) {
			if (expanded.value.has(id) || next?.has(id)) continue;
			next ??= new Set(expanded.value);
			next.add(id);
		}
		if (next) expanded.value = next;
	}

	watch(
		[source.threadKey, source.activeId, source.messages],
		([key, active, messages]) => {
			if (key !== threadKey) {
				threadKey = key;
				activeId = active;
				known = null;
				expanded.value = new Set([active]);
			} else if (active !== activeId) {
				activeId = active;
				addIds([active]);
			}
			// Still loading: the placeholder list must not count as the thread,
			// or every message of the real list would look newly arrived.
			if (!messages) return;
			if (!known) {
				known = new Set(messages.map((m) => m._id));
				expanded.value = initialExpandedIds(messages, active);
				return;
			}
			const arrived: string[] = [];
			for (const m of messages) {
				if (known.has(m._id)) continue;
				known.add(m._id);
				arrived.push(m._id);
			}
			addIds(arrived);
		},
		{ immediate: true }
	);

	function toggleExpanded(id: string) {
		const next = new Set(expanded.value);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded.value = next;
	}

	return { expanded, toggleExpanded };
}
