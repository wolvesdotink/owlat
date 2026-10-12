/**
 * Convex wiring for {@link useDraftRevise}: builds the injected network
 * primitives (create buffer → run streaming revise → delete buffer) and the
 * reactive buffer snapshot the state machine renders from.
 *
 * Kept separate from the pure state machine so the latter unit-tests without a
 * live Convex client. The reactive `getDraftStream` subscription re-points at
 * the active buffer id the moment `start()` sets it, so streamed tokens land in
 * `snapshot` and render progressively into the composer / review pane.
 */

import { ref, computed } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import { isBudgetStreamError } from '~/utils/aiBudget';
import {
	useDraftRevise,
	type ReviseInput,
	type ReviseResult,
	type ReviseStreamSnapshot,
} from '~/composables/postbox/useDraftRevise';

export interface DraftReviseConvexOptions {
	surface: 'compose' | 'review';
	/** Mailbox whose voice profile personalizes the revise (optional). */
	mailboxId?: () => Id<'mailboxes'> | undefined;
	onError?: (message: string) => void;
}

/**
 * U5: a revise the spend budget refused settles its buffer with the stable
 * code as `errorMessage` (the action itself only answers `error`). Read it
 * once, so the composer says it was the budget rather than a failure.
 */
async function budgetStreamCode(streamId: string): Promise<string | undefined> {
	try {
		const row = await requireConvex().query(api.mail.draftStreamStore.getDraftStream, {
			streamId: streamId as Id<'aiDraftStreams'>,
		});
		return isBudgetStreamError(row?.errorMessage) ? AI_BUDGET_ERROR_CODE : undefined;
	} catch {
		return undefined;
	}
}

export function useDraftReviseConvex(opts: DraftReviseConvexOptions) {
	const activeStreamId = ref<Id<'aiDraftStreams'> | null>(null);

	// Reactive read of the active buffer; skips entirely when none is active.
	const streamQuery = useConvexQuery(
		api.mail.draftStreamStore.getDraftStream,
		() => (activeStreamId.value ? { streamId: activeStreamId.value } : 'skip'),
		{ keepPreviousData: false }
	);

	const snapshot = computed<ReviseStreamSnapshot | null>(() => {
		const d = streamQuery.data.value;
		if (!d) return null;
		return {
			status: d.status,
			text: d.text,
			injectionFlagged: d.injectionFlagged,
			errorMessage: d.errorMessage,
		};
	});

	const revise = useDraftRevise({
		createStream: async () => {
			const id = await requireConvex().mutation(api.mail.draftStreamStore.createDraftStream, {
				surface: opts.surface,
			});
			return id as string;
		},
		runRevise: async (streamId: string, input: ReviseInput): Promise<ReviseResult> => {
			const mailboxId = opts.mailboxId?.();
			const res = await requireConvex().action(api.mail.ai.reviseDraft.reviseDraft, {
				streamId: streamId as Id<'aiDraftStreams'>,
				instruction: input.instruction,
				currentDraft: input.currentDraft,
				...(input.threadContext ? { threadContext: input.threadContext } : {}),
				...(mailboxId ? { mailboxId } : {}),
				surface: opts.surface,
			});
			const errorCode =
				res?.errorCode ?? (res?.status === 'error' ? await budgetStreamCode(streamId) : undefined);
			return {
				status: res?.status ?? 'error',
				text: res?.text ?? '',
				injectionFlagged: res?.injectionFlagged ?? false,
				...(errorCode ? { errorCode } : {}),
			};
		},
		deleteStream: async (streamId: string) => {
			await requireConvex().mutation(api.mail.draftStreamStore.deleteDraftStream, {
				streamId: streamId as Id<'aiDraftStreams'>,
			});
		},
		snapshot,
		setActiveStreamId: (id) => {
			activeStreamId.value = (id as Id<'aiDraftStreams'> | null) ?? null;
		},
		...(opts.onError ? { onError: opts.onError } : {}),
	});

	return revise;
}
