import type { Id } from '@owlat/api/dataModel';
import { isEditableTarget, resolvePostboxShortcut } from '~/utils/postboxShortcuts';

/**
 * The two window-level dispatchers of the thread reader, both feeding
 * `runAction`:
 *
 *  - Single-key shortcuts while reading (same vocabulary as the list; see
 *    utils/postboxShortcuts.ts). Inert while focus is in an input or
 *    contenteditable, and deferring to the list's own listbox handler and to
 *    open dialogs so a key is never handled twice.
 *  - The Cmd-K palette bridge: commands demoted into overflow menus (reply-all,
 *    forward, report spam, block sender, print, …) dispatch
 *    `owlat:postbox-reader-action` so they stay discoverable and runnable
 *    without a visible button.
 *
 * Listeners are registered on mount and removed before unmount. Extracted from
 * PostboxThreadReader.vue; behaviour is unchanged.
 */
export function usePostboxReaderShortcuts(opts: {
	runAction: (action: string) => void;
	/** "Label as…" is the one palette command that carries an argument. */
	applyLabel: (labelId: Id<'mailLabels'>) => void;
}) {
	function onReaderShortcut(event: KeyboardEvent) {
		// Alt matters too: on Windows the browser-menu accelerators (Alt+E, Alt+F)
		// deliver plain keydowns with altKey — never treat those as triage keys.
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isEditableTarget(event.target)) return;
		// Already claimed on the way up — most often the second half of a `g`
		// sequence chord, which the app-wide dispatcher completed at the document
		// level. Acting on it here as well would star AND navigate on `g` `s`.
		if (event.defaultPrevented) return;
		const el = event.target as HTMLElement | null;
		// The focused thread list and any open dialog own their keys.
		if (el?.closest?.('[role="listbox"], [role="dialog"]')) return;
		const action = resolvePostboxShortcut(event.key);
		// '?' is handled by the window-level PostboxShortcutHelp listener.
		if (!action || action === 'help') return;
		event.preventDefault();
		opts.runAction(action);
	}

	function onPaletteCommand(event: Event) {
		const detail = (event as CustomEvent<{ action?: string; labelId?: string }>).detail;
		if (!detail?.action) return;
		if (detail.action === 'label') {
			if (detail.labelId) opts.applyLabel(detail.labelId as Id<'mailLabels'>);
			return;
		}
		opts.runAction(detail.action);
	}

	onMounted(() => {
		window.addEventListener('keydown', onReaderShortcut);
		window.addEventListener('owlat:postbox-reader-action', onPaletteCommand);
	});
	onBeforeUnmount(() => {
		window.removeEventListener('keydown', onReaderShortcut);
		window.removeEventListener('owlat:postbox-reader-action', onPaletteCommand);
	});
}
