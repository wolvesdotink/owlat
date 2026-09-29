/**
 * Undo-send window for Postbox mail.
 *
 * An undo window (useUndoWindow). `usePostboxCompose().send()` arms it after
 * every send that went out or was queued, so each host (popup, inline reply,
 * desktop compose window) gets it without wiring; PostboxUndoSendToast reads
 * the shared state, shows the countdown and owns the reversal (cancel on the
 * server, or un-queue an offline send).
 */

import type { Id } from '@owlat/api/dataModel';
import { useUndoWindow } from '~/composables/useUndoWindow';

interface UndoSendWindow {
	undoToken: string | null;
	mailboxId: Id<'mailboxes'> | null;
}

export function usePostboxUndoSend() {
	const {
		state,
		arm: armWindow,
		dismiss,
		runUndo,
	} = useUndoWindow<UndoSendWindow>('postbox:undo-send', () => ({
		undoToken: null,
		mailboxId: null,
	}));

	// Optional send-confirmation sound. Gated on the (default-off) preference;
	// `playSend` no-ops entirely when it's disabled, so this is inert unless the
	// user opted in. Arming happens once per completed send (in the composer's
	// send()), so the sound fires once per send — not on button press and not
	// again after the undo window expires.
	const { sendSound } = usePostboxSettings();
	const { playSend } = useUiSound(sendSound);

	function arm(args: { undoToken: string; sendAt: number; mailboxId: Id<'mailboxes'> }) {
		armWindow({ undoToken: args.undoToken, sendAt: args.sendAt, mailboxId: args.mailboxId });
		playSend();
	}

	return { state, arm, dismiss, runUndo };
}
