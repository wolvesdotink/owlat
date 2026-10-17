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
 * Undo for read-on-arrival operations (SPEC §4.4): Fix, sender status (the
 * Senders page, ⇧E, ⇧O, Keep), suggestions, the learned-digest notice.
 *
 * `offerUndo` shows the toast that says what happened, with an Undo button
 * that runs `api.mail.arrival.operations.undo`. The FINAL outcome is
 * announced: an undo larger than one page continues on the server, and this
 * composable subscribes to `operations.undoStatus` until its last page ran,
 * then says what could not come back (a reply reminder an archive cleared,
 * an unsubscribe request already sent, rows changed since: `undo_partial`).
 */
export function usePostboxArrivalUndo() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const undoOp = useBackendOperation(api.mail.arrival.operations.undo, {
		label: () => t('postbox.undo.operation'),
	});

	function announce(outcome: UndoOutcome): void {
		const lines = [
			outcome.isNeedsReplyCleared
				? t('postbox.undo.movedBackNoReminders')
				: outcome.status === 'undo_partial'
					? t('postbox.undo.partial')
					: t('postbox.undo.done'),
		];
		if (outcome.kind === 'unsubscribe') lines.push(t('postbox.undo.unsubscribeNotRecalled'));
		showToast(lines.join(' '), outcome.status === 'undo_partial' ? 'info' : 'success');
	}

	// Undos still running in the background, until their last page reports.
	const pending = ref<Id<'mailArrivalOperations'>[]>([]);
	const statuses = useConvexQueryMap(api.mail.arrival.operations.undoStatus, pending, (id) => ({
		operationId: id,
	}));
	watch(
		() => pending.value.map((id) => [id, statuses.get(id)?.data.value] as const),
		(entries) => {
			for (const [id, status] of entries) {
				if (!status?.isDone) continue;
				pending.value = pending.value.filter((other) => other !== id);
				announce(status);
			}
		}
	);

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
			pending.value = [...pending.value, operationId];
			return true;
		}
		announce(result);
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
			action: { label: t('common.undo'), onAction: () => void undo(operationId) },
			...(opts.onDismiss ? { onDismiss: opts.onDismiss } : {}),
		});
	}

	return { offerUndo, undo, isUndoing: undoOp.isLoading };
}
