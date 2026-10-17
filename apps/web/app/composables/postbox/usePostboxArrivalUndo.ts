import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** How long a toast with Undo stays: long enough to read it and reach the button. */
const UNDO_TOAST_MS = 8000;

/**
 * Undo for read-on-arrival operations (SPEC §4.4): Fix, sender status (the
 * Senders page, ⇧E, ⇧O, Keep), suggestions, the learned-digest notice.
 *
 * `offerUndo` shows the toast that says what happened, with an Undo button
 * that runs `api.mail.arrival.operations.undo`. Its result toast is honest
 * about what could not come back: a reply reminder an archive cleared
 * ("Moved back; reply reminders were not restored"), an unsubscribe request
 * already sent, rows something else changed since (`undo_partial`).
 */
export function usePostboxArrivalUndo() {
	const { t } = useI18n();
	const { showToast } = useToast();
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
		const lines = [
			result.isNeedsReplyCleared
				? t('postbox.undo.movedBackNoReminders')
				: result.status === 'undo_partial'
					? t('postbox.undo.partial')
					: t('postbox.undo.done'),
		];
		if (result.kind === 'unsubscribe') lines.push(t('postbox.undo.unsubscribeNotRecalled'));
		showToast(lines.join(' '), result.status === 'undo_partial' ? 'info' : 'success');
		return true;
	}

	/** Say what an operation did, with Undo. Without an operation id there is nothing to undo. */
	function offerUndo(
		message: string,
		operationId: Id<'mailArrivalOperations'> | null | undefined,
		opts: { onDismiss?: () => void; type?: 'success' | 'info' } = {}
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
