/**
 * Undo-send window for Postbox mail.
 *
 * An undo window (useUndoWindow). `usePostboxCompose().send()` arms it after
 * every send that went out or was queued, so each host (compose page, Answer mode,
 * desktop compose window) gets it without wiring; PostboxUndoSendToast reads
 * the shared state, shows the countdown and owns the reversal (cancel on the
 * server, or un-queue an offline send).
 */

import type { Id } from '@owlat/api/dataModel';
import { useUndoWindow } from '~/composables/useUndoWindow';

interface UndoSendWindow {
	undoToken: string | null;
	mailboxId: Id<'mailboxes'> | null;
	/** The message a reply answered: undo reopens the draft in Answer mode on it. */
	replyToMessageId?: Id<'mailMessages'> | null;
}

const UNDO_SEND_KEY = 'postbox:undo-send';
const emptyUndoSend = (): UndoSendWindow => ({ undoToken: null, mailboxId: null });

/**
 * Whether an undo-send window is open. For the shell's composer host, which
 * mounts the stack (and with it the toast) while one is, without pulling in
 * the send-sound wiring below.
 */
export function usePostboxUndoSendVisible() {
	const { state } = useUndoWindow<UndoSendWindow>(UNDO_SEND_KEY, emptyUndoSend);
	return computed(() => state.value.visible);
}

export function usePostboxUndoSend() {
	const {
		state,
		arm: armWindow,
		dismiss,
		runUndo,
	} = useUndoWindow<UndoSendWindow>(UNDO_SEND_KEY, emptyUndoSend);

	// Optional send-confirmation sound. Gated on the (default-off) preference;
	// `playSend` no-ops entirely when it's disabled, so this is inert unless the
	// user opted in. Arming happens once per completed send (in the composer's
	// send()), so the sound fires once per send — not on button press and not
	// again after the undo window expires.
	const { sendSound } = usePostboxSettings();
	const { playSend } = useUiSound(sendSound);

	function arm(args: {
		undoToken: string;
		sendAt: number;
		mailboxId: Id<'mailboxes'>;
		replyToMessageId?: Id<'mailMessages'>;
	}) {
		armWindow({
			undoToken: args.undoToken,
			sendAt: args.sendAt,
			mailboxId: args.mailboxId,
			replyToMessageId: args.replyToMessageId ?? null,
		});
		playSend();
	}

	return { state, arm, dismiss, runUndo };
}
