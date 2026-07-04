/**
 * Whole-draft REVISE-by-instruction state machine, shared by the Postbox
 * composer and the inbox review gate.
 *
 * The user types a freeform instruction ("redo but decline politely", "add that
 * the invoice is attached") and the backend rewrites the ENTIRE draft, streaming
 * tokens back through an owner-private `aiDraftStreams` buffer so the text fills
 * in progressively instead of showing a spinner. This composable is the pure
 * DOM/network-agnostic controller: it owns the request lifecycle and exposes the
 * live/streamed text; the network primitives (create buffer, run action, delete
 * buffer) and the reactive buffer snapshot are INJECTED so it unit-tests without
 * Convex — mirroring {@link usePostboxCoach}.
 *
 * Advisory + fail-soft: the revised draft is NEVER auto-applied — the caller
 * shows it and the user clicks Apply. A request error surfaces via `onError` and
 * leaves the existing draft untouched. The backend runs the injection safety
 * scan on the FINAL text and returns an advisory `injectionFlagged`; the caller
 * can warn the user, but nothing here sends anything.
 */

import { ref, computed, type Ref } from 'vue';

export type ReviseStatus = 'idle' | 'streaming' | 'done' | 'error';

/** The reactive shape the caller feeds from its buffer subscription. */
export interface ReviseStreamSnapshot {
	status: 'streaming' | 'complete' | 'error';
	text: string;
	injectionFlagged: boolean;
	errorMessage?: string | null;
}

export interface ReviseInput {
	instruction: string;
	currentDraft: string;
	threadContext?: string;
}

export interface ReviseResult {
	status: 'complete' | 'error';
	text: string;
	injectionFlagged: boolean;
}

export interface DraftReviseDeps {
	/** Create an owner-private stream buffer; resolves to its id. */
	createStream: () => Promise<string>;
	/** Run the streaming revise action against a buffer. */
	runRevise: (streamId: string, input: ReviseInput) => Promise<ReviseResult>;
	/** Delete a buffer once the result is applied/discarded (best-effort). */
	deleteStream: (streamId: string) => Promise<void>;
	/** Reactive snapshot of the ACTIVE buffer (null when none). */
	snapshot: Ref<ReviseStreamSnapshot | null>;
	/** Point the caller's subscription at a buffer id (null to stop). */
	setActiveStreamId: (id: string | null) => void;
	/** Surface a fail-soft error message (toast). */
	onError?: (message: string) => void;
}

/** A revise is offered only when AI is on and there is a draft to revise. */
export function isReviseEligible(aiEnabled: boolean, draft: string): boolean {
	return aiEnabled && draft.trim().length > 0;
}

export function useDraftRevise(deps: DraftReviseDeps) {
	const status = ref<ReviseStatus>('idle');
	const result = ref<string>('');
	const injectionFlagged = ref(false);
	let activeStreamId: string | null = null;

	/** Text to render: the live streaming buffer while running, else the result. */
	const displayText = computed(() => {
		if (status.value === 'streaming') return deps.snapshot.value?.text ?? '';
		return result.value;
	});

	const isStreaming = computed(() => status.value === 'streaming');
	const hasResult = computed(() => status.value === 'done' && result.value.length > 0);

	async function cleanup(): Promise<void> {
		const id = activeStreamId;
		activeStreamId = null;
		deps.setActiveStreamId(null);
		if (id) {
			try {
				await deps.deleteStream(id);
			} catch {
				// best-effort: a stale buffer expires on its own; never surface.
			}
		}
	}

	/** Kick off a revise. Guards empty instructions; safe to call repeatedly. */
	async function start(input: ReviseInput): Promise<void> {
		if (status.value === 'streaming') return;
		const instruction = input.instruction.trim();
		if (!instruction || !input.currentDraft.trim()) return;

		status.value = 'streaming';
		result.value = '';
		injectionFlagged.value = false;
		try {
			const streamId = await deps.createStream();
			activeStreamId = streamId;
			deps.setActiveStreamId(streamId);
			const res = await deps.runRevise(streamId, { ...input, instruction });
			if (res.status === 'error') {
				status.value = 'error';
				deps.onError?.('Revise failed — your draft is unchanged.');
				await cleanup();
				return;
			}
			result.value = res.text;
			injectionFlagged.value = res.injectionFlagged;
			status.value = 'done';
		} catch {
			status.value = 'error';
			deps.onError?.('Revise failed — your draft is unchanged.');
			await cleanup();
		}
	}

	/** Take the revised text and reset (caller applies it to the editor). */
	async function apply(): Promise<string | null> {
		if (status.value !== 'done') return null;
		const text = result.value;
		await reset();
		return text;
	}

	/** Discard the result/buffer and return to idle. */
	async function reset(): Promise<void> {
		status.value = 'idle';
		result.value = '';
		injectionFlagged.value = false;
		await cleanup();
	}

	return {
		status,
		displayText,
		isStreaming,
		hasResult,
		injectionFlagged,
		start,
		apply,
		reset,
	};
}
