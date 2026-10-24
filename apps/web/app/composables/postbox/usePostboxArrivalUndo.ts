import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { ref, watch } from 'vue';
import { useConvexQueryMap } from '~/composables/useConvexQueryMap';

/** How long a toast with Undo stays: long enough to read it and reach the button. */
const UNDO_TOAST_MS = 8000;

/** What an undo's announcement needs, from the first page or from `undoStatus`. */
interface UndoOutcome {
	status: 'undone' | 'undo_partial';
	kind: string;
	isNeedsReplyCleared: boolean;
}

/**
 * Undos still running on the server (more pages, or a sender re-sort chain),
 * app-wide: whichever component started one may be gone before it finishes.
 * `PostboxArrivalUndoHost` (mounted in app.vue while this is not empty)
 * subscribes to each and announces its outcome.
 */
export const pendingArrivalUndos = ref<Id<'mailArrivalOperations'>[]>([]);

/**
 * The outcome in words. Each fact is its own sentence, so none hides another:
 * the result (undone, or partly), lost reply reminders, an unsubscribe request
 * that cannot be recalled.
 */
function outcomeText(t: (key: string) => string, outcome: UndoOutcome): string {
	const lines = [
		outcome.status === 'undo_partial'
			? t('postbox.undo.partial')
			: outcome.isNeedsReplyCleared
				? t('postbox.undo.movedBack')
				: t('postbox.undo.done'),
	];
	if (outcome.isNeedsReplyCleared) lines.push(t('postbox.undo.remindersNotRestored'));
	if (outcome.kind === 'unsubscribe') lines.push(t('postbox.undo.unsubscribeNotRecalled'));
	return lines.join(' ');
}

function useAnnounce() {
	const { t } = useI18n();
	const { showToast } = useToast();
	return (outcome: UndoOutcome) =>
		showToast(outcomeText(t, outcome), outcome.status === 'undo_partial' ? 'info' : 'success');
}

/**
 * The app-lifetime half (`PostboxArrivalUndoHost`): one `undoStatus`
 * subscription per pending undo, and its announcement once it is done.
 */
export function usePostboxArrivalUndoAnnouncer(): void {
	const announce = useAnnounce();
	const statuses = useConvexQueryMap(
		api.mail.arrival.operations.undoStatus,
		pendingArrivalUndos,
		(id) => ({ operationId: id })
	);
	watch(
		() => pendingArrivalUndos.value.map((id) => [id, statuses.get(id)?.data.value] as const),
		(entries) => {
			for (const [id, status] of entries) {
				if (!status?.isDone) continue;
				pendingArrivalUndos.value = pendingArrivalUndos.value.filter((other) => other !== id);
				announce(status);
			}
		},
		{ immediate: true }
	);
}

/**
 * Undo for read-on-arrival operations: Fix, sender status (the
 * Senders page, ⇧E, ⇧O, Keep), suggestions, the learned-digest notice.
 *
 * `offerUndo` shows the toast that says what happened, with an Undo button
 * that runs `api.mail.arrival.operations.undo`. The FINAL outcome is
 * announced: a one-page undo at once; a longer one (more pages, or a sender
 * re-sort chain, §16) is handed to {@link pendingArrivalUndos}, and the
 * app-level host announces it when the server reports `isDone`.
 */
export function usePostboxArrivalUndo() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const announce = useAnnounce();
	const undoOp = useBackendOperation(api.mail.arrival.operations.undo, {
		label: () => t('postbox.undo.operation'),
	});

	async function undo(operationId: Id<'mailArrivalOperations'>): Promise<boolean> {
		const run = await undoOp.run({ operationId });
		if (!run.ok) return false;
		const result = run.result;
		if (result.status === 'expired') {
			showToast(t('postbox.undo.expired'), 'info');
			return false;
		}
		if (result.status === 'not_applied') {
			showToast(t('postbox.undo.already'), 'info');
			return false;
		}
		if (result.hasMore) {
			showToast(t('postbox.undo.inProgress'), 'info');
			if (!pendingArrivalUndos.value.includes(operationId)) {
				pendingArrivalUndos.value = [...pendingArrivalUndos.value, operationId];
			}
			return true;
		}
		announce({
			status: result.status,
			kind: result.kind,
			isNeedsReplyCleared: result.isNeedsReplyCleared,
		});
		return true;
	}

	/** Say what an operation did, with Undo. Without an operation id there is nothing to undo. */
	function offerUndo(
		message: string,
		operationId: Id<'mailArrivalOperations'> | null | undefined,
		opts: { onDismiss?: () => void; type?: 'success' | 'info' | 'error' } = {}
	): void {
		if (!operationId) {
			showToast(message, opts.type ?? 'success');
			return;
		}
		showToast(message, opts.type ?? 'success', {
			durationMs: UNDO_TOAST_MS,
			// The toast waits for the undo: "Undoing…" while it runs, gone once it
			// worked, marked "Not undone" when it did not. `false` covers both a
			// failure (useBackendOperation already toasted it) and a terminal
			// "expired" / "already undone"; neither is safe to offer again.
			observedAction: {
				label: t('common.undo'),
				pendingLabel: t('postbox.undo.undoing'),
				failedNote: t('postbox.undo.notUndone'),
				run: () => undo(operationId),
			},
			...(opts.onDismiss ? { onDismiss: opts.onDismiss } : {}),
		});
	}

	return { offerUndo, undo, isUndoing: undoOp.isLoading };
}
