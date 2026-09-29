/**
 * Streamed suggested replies, shared by the three surfaces that ask for them:
 * the reader's inline reply box, the scheduling chip, and the Answer queue's
 * "Draft reply".
 *
 * `mail.ai.assist.suggestReplies` runs on the fast tier and, given a `suggest`
 * buffer (`aiDraftStreams`), writes the options into it as they form. This
 * composable creates the buffer, subscribes to it, runs the action, and exposes
 * `replies` — the options so far while the action runs, the final list once it
 * returns. While streaming, every option but the last is final (`readyCount`);
 * the last one is still being written.
 *
 * Fail-soft like before: if the buffer cannot be created the action runs
 * without one (options appear all at once), and a failed action leaves
 * `replies` empty. The buffer holds the options as a JSON array; the server
 * owns the parsing (mail/replyOptions.ts), the client only decodes.
 *
 * The pure controller ({@link createSuggestReplies}) takes its network pieces
 * injected so it unit-tests without Convex, like {@link useDraftRevise}.
 */

import { ref, computed, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export interface SuggestRepliesArgs {
	messageId: Id<'mailMessages'>;
	focus?: 'scheduling';
	proposedTimes?: string[];
}

/** The part of the buffer row the controller reads. */
export interface SuggestStreamSnapshot {
	status: 'streaming' | 'complete' | 'error';
	text: string;
}

export interface SuggestRepliesDeps {
	/** Create an owner-private `suggest` buffer; resolves to its id. */
	createStream: () => Promise<string>;
	/** Run the action; resolves to the final replies, or null when it failed. */
	runSuggest: (args: SuggestRepliesArgs & { streamId?: string }) => Promise<string[] | null>;
	/** Delete a buffer once its run is over (best-effort). */
	deleteStream: (streamId: string) => Promise<void>;
	/** Reactive snapshot of the ACTIVE buffer (null when none). */
	snapshot: Ref<SuggestStreamSnapshot | null>;
	/** Point the subscription at a buffer id (null to stop). */
	setActiveStreamId: (id: string | null) => void;
}

/** Decode a buffer's `text` (a JSON array of options). Anything else is no options. */
export function decodeStreamedReplies(text: string | undefined | null): string[] {
	if (!text) return [];
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value)
			? value.filter((r): r is string => typeof r === 'string' && r.length > 0)
			: [];
	} catch {
		return [];
	}
}

export function createSuggestReplies(deps: SuggestRepliesDeps) {
	const busy = ref(false);
	/** The last run's final list; null while a run is streaming (or before any). */
	const settled = ref<string[] | null>(null);
	// Bumped by every run and clear(), so a superseded run never writes state.
	let generation = 0;

	const streamed = computed(() =>
		busy.value ? decodeStreamedReplies(deps.snapshot.value?.text) : []
	);
	/** The options to render: streamed so far, then the final list. */
	const replies = computed(() => settled.value ?? streamed.value);
	/** How many of `replies` are final and safe to pick. */
	const readyCount = computed(() => {
		if (settled.value) return settled.value.length;
		if (deps.snapshot.value?.status === 'complete') return streamed.value.length;
		return Math.max(0, streamed.value.length - 1);
	});

	async function openStream(gen: number): Promise<string | undefined> {
		try {
			const id = await deps.createStream();
			if (gen === generation) deps.setActiveStreamId(id);
			return id;
		} catch {
			// No buffer: the action still returns the options, just not streamed.
			return undefined;
		}
	}

	/** Ask for options; resolves to the final list ([] when the action failed). */
	async function run(args: SuggestRepliesArgs): Promise<string[]> {
		const gen = ++generation;
		busy.value = true;
		settled.value = null;
		const streamId = await openStream(gen);
		let result: string[] = [];
		try {
			result = (await deps.runSuggest({ ...args, ...(streamId ? { streamId } : {}) })) ?? [];
		} catch {
			result = [];
		}
		if (gen === generation) {
			settled.value = result;
			busy.value = false;
			deps.setActiveStreamId(null);
		}
		if (streamId) {
			try {
				await deps.deleteStream(streamId);
			} catch {
				// best-effort: a leftover buffer is harmless and owner-private.
			}
		}
		return result;
	}

	/**
	 * Resolve with the first option as soon as it is final (the second one has
	 * started, or the run ended) — for callers that only use one. The run keeps
	 * going in the background so its spend is recorded and its buffer cleaned up.
	 */
	function first(args: SuggestRepliesArgs): Promise<string> {
		return new Promise<string>((resolve) => {
			let done = false;
			const finish = (text: string) => {
				if (done) return;
				done = true;
				stop();
				resolve(text);
			};
			const stop = watch(readyCount, (n) => {
				if (n > 0 && busy.value) finish(replies.value[0] ?? '');
			});
			void run(args).then((r) => finish(r[0] ?? ''));
		});
	}

	/** Forget the current options (another conversation); a running call is let finish. */
	function clear(): void {
		generation++;
		busy.value = false;
		settled.value = null;
		deps.setActiveStreamId(null);
	}

	return { replies, readyCount, busy, run, first, clear };
}

/** Convex wiring for {@link createSuggestReplies}. */
export function useSuggestReplies(opts: { label: () => string }) {
	const activeStreamId = ref<Id<'aiDraftStreams'> | null>(null);
	const streamQuery = useConvexQuery(
		api.mail.draftStreamStore.getDraftStream,
		() => (activeStreamId.value ? { streamId: activeStreamId.value } : 'skip'),
		{ keepPreviousData: false }
	);
	const snapshot = computed<SuggestStreamSnapshot | null>(() => {
		const d = streamQuery.data.value;
		return d ? { status: d.status, text: d.text } : null;
	});
	const suggestOp = useBackendOperation(api.mail.ai.assist.suggestReplies, {
		label: opts.label,
		type: 'action',
	});

	return createSuggestReplies({
		createStream: async () =>
			(await requireConvex().mutation(api.mail.draftStreamStore.createDraftStream, {
				surface: 'suggest',
			})) as string,
		runSuggest: async ({ streamId, ...args }) => {
			const res = await suggestOp.run({
				...args,
				...(streamId ? { streamId: streamId as Id<'aiDraftStreams'> } : {}),
			});
			return res.ok ? res.result.replies : null;
		},
		deleteStream: async (streamId) => {
			await requireConvex().mutation(api.mail.draftStreamStore.deleteDraftStream, {
				streamId: streamId as Id<'aiDraftStreams'>,
			});
		},
		snapshot,
		setActiveStreamId: (id) => {
			activeStreamId.value = (id as Id<'aiDraftStreams'> | null) ?? null;
		},
	});
}
