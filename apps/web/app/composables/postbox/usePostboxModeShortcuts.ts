/**
 * Window-level mode shortcuts for the Postbox browse shell: B (and Cmd/Ctrl-B)
 * toggles Today ↔ Browse from the inbox list; Esc returns from Browse to Today
 * (and closes the stack-mode folder drawer); `/` from Today jumps to Browse
 * with the search focused. All inert in text inputs, while a message is open,
 * and while any dialog is up.
 */
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';

export function usePostboxModeShortcuts(args: {
	/** The route's folder role — the grammar is inbox-only. */
	folderRole: Ref<string>;
	isCustomFolder: Ref<boolean>;
	activeMessageId?: Ref<string | null>;
	/** The stack-mode drawer, whose Esc takes priority when open. */
	drawerOpen: Ref<boolean>;
	currentMode: Ref<PostboxInboxMode>;
	/** True while the focused Today landing view is up (`/` hands off to Browse). */
	todayActive: Ref<boolean>;
	switchMode: (mode: PostboxInboxMode) => void;
}) {
	const searchAutofocus = useState('postbox:search-autofocus', () => false);

	function onModeKeydown(event: KeyboardEvent) {
		// The stack-mode folder drawer is modal: Esc closes it before any other
		// shortcut applies (and the rest of the mode grammar stays inert while
		// it is open, matching the dialog guard below).
		if (args.drawerOpen.value) {
			if (event.key === 'Escape') {
				event.preventDefault();
				args.drawerOpen.value = false;
			}
			return;
		}
		if (
			args.folderRole.value !== 'inbox' ||
			args.isCustomFolder.value ||
			args.activeMessageId?.value
		)
			return;
		if (isEditableTarget(event.target)) return;
		if (event.defaultPrevented) return;
		if (document.querySelector('[role="dialog"]')) return;
		if (event.key.toLowerCase() === 'b' && !event.altKey && !event.shiftKey) {
			event.preventDefault();
			args.switchMode(args.currentMode.value === 'today' ? 'browse' : 'today');
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'Escape' && args.currentMode.value === 'browse') {
			args.switchMode('today');
			return;
		}
		if (event.key === '/' && args.todayActive.value) {
			event.preventDefault();
			searchAutofocus.value = true;
			args.switchMode('browse');
		}
	}

	onMounted(() => window.addEventListener('keydown', onModeKeydown));
	onBeforeUnmount(() => window.removeEventListener('keydown', onModeKeydown));
}
