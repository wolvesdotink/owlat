/**
 * Undo-send toast state machine.
 *
 * Held by a singleton useState so any composer's send() can hand off
 * the undoToken and dismiss its UI; the toast component reads the
 * shared state and shows itself for the remaining window.
 */

import type { Id } from '@owlat/api/dataModel';

interface UndoSendState {
	visible: boolean;
	undoToken: string | null;
	sendAt: number;
	mailboxId: Id<'mailboxes'> | null;
}

export function usePostboxUndoSend() {
	const state = useState<UndoSendState>('postbox:undo-send', () => ({
		visible: false,
		undoToken: null,
		sendAt: 0,
		mailboxId: null,
	}));

	// Optional send-confirmation sound. Gated on the (default-off) preference;
	// `playSend` no-ops entirely when it's disabled, so this is inert unless the
	// user opted in. This is the single send-dispatch point (the undo window
	// arming), so the sound fires once per send — not on button press and not
	// again after the undo window expires.
	const { sendSound } = usePostboxSettings();
	const { playSend } = useUiSound(sendSound);

	function arm(args: { undoToken: string; sendAt: number; mailboxId: Id<'mailboxes'> }) {
		state.value = {
			visible: true,
			undoToken: args.undoToken,
			sendAt: args.sendAt,
			mailboxId: args.mailboxId,
		};
		playSend();
	}

	function dismiss() {
		state.value = { visible: false, undoToken: null, sendAt: 0, mailboxId: null };
	}

	return { state, arm, dismiss };
}
