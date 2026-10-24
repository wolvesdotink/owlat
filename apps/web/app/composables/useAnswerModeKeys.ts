import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { isDialogOpen } from '~/utils/dialogOpen';
import { isEditableTarget } from '~/utils/postboxShortcuts';

/**
 * The keys of an Answer mode page, bound to the `answer` scope that
 * AnswerModeFrame claims, so a remap on the shortcuts page moves them.
 *
 * ⌘J is "Draft with AI" here; the app-wide Assistant has the same chord, and
 * the nearer scope wins it. Esc first lets go of the editor and only then
 * leaves, so a person who was typing does not lose the page on one press.
 * None of the keys fire while a dialog is open over the page: the dialog
 * owns them.
 */
export function useAnswerModeKeys(actions: {
	leave: () => void;
	toggleView: () => void;
	draftWithAi: () => void;
	/** Team inbox threads only. */
	writeNote?: () => void;
}): void {
	const { registerShortcut } = useKeyboardShortcuts();
	const noDialog = () => !isDialogOpen();
	registerShortcut({
		id: 'answer.leave',
		handler: () => {
			const active = document.activeElement;
			if (isEditableTarget(active) && active instanceof HTMLElement) active.blur();
			else actions.leave();
		},
		when: noDialog,
	});
	registerShortcut({ id: 'answer.toggleView', handler: actions.toggleView, when: noDialog });
	registerShortcut({ id: 'answer.draftWithAi', handler: actions.draftWithAi });
	const writeNote = actions.writeNote;
	if (writeNote) registerShortcut({ id: 'answer.writeNote', handler: writeNote, when: noDialog });
}
