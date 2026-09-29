/**
 * Which messages of the open thread the reader shows expanded.
 *
 * The default set is computed once per thread, from the first loaded message
 * list: the latest message, the first one when the thread has more than two,
 * every unread message and the active one. After that the set only grows: a
 * message that arrives later (a reply, a sync) is added, nothing is taken away.
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
	for (const m of messages) if (!m.flagSeen) next.add(m._id);
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
