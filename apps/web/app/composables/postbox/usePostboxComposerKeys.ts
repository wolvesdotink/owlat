/**
 * Keyboard shortcuts for the Postbox composer:
 * Cmd/Ctrl+Enter send, Cmd/Ctrl+Shift+Enter schedule, Esc minimize.
 *
 * The returned handler is meant to be bound on the composer ROOT element with
 * `@keydown.capture` — NOT globally — so each stacked popup composer only
 * handles its own keys.
 */

import type { Ref } from 'vue';
import { resolveComposerKeyAction } from '~/utils/postboxComposerKeys';

export function usePostboxComposerKeys(options: {
	/** The composer root element the keydown listener is bound to. */
	rootEl: Ref<HTMLElement | null>;
	canSend: Ref<boolean>;
	sending: Ref<boolean>;
	isScheduled: Ref<boolean>;
	/** Whether the schedule-send dialog is currently open. */
	scheduleOpen: Ref<boolean>;
	onSend: () => void;
	onSchedule: () => void;
	onMinimize: () => void;
}) {
	const isMac = computed(
		() => import.meta.client && /Mac|iP(hone|ad|od)/.test(navigator.platform),
	);
	const sendShortcutHint = computed(() =>
		isMac.value ? 'Send (⌘↵)' : 'Send (Ctrl+Enter)',
	);
	const scheduleShortcutHint = computed(() =>
		isMac.value ? 'Schedule send (⌘⇧↵)' : 'Schedule send (Ctrl+Shift+Enter)',
	);

	/**
	 * Esc must close an open inner dialog/dropdown instead of minimizing:
	 * - the schedule dialog (tracked state),
	 * - the recipient autocomplete (marked with data-postbox-overlay-open),
	 * - a focused native <select> (signature / From picker) whose dropdown state
	 *   the DOM cannot expose — treat a focused select as "overlay open".
	 */
	function hasOpenInnerOverlay(event: KeyboardEvent): boolean {
		if (options.scheduleOpen.value) return true;
		if (event.target instanceof HTMLSelectElement) return true;
		return !!options.rootEl.value?.querySelector('[data-postbox-overlay-open]');
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		const action = resolveComposerKeyAction(event, {
			canSend:
				options.canSend.value &&
				!options.sending.value &&
				!options.isScheduled.value,
			overlayOpen: hasOpenInnerOverlay(event),
		});
		if (!action) return;
		event.preventDefault();
		event.stopPropagation();
		if (action === 'send') {
			options.onSend();
		} else if (action === 'schedule') {
			options.onSchedule();
		} else {
			options.onMinimize();
		}
	}

	return { sendShortcutHint, scheduleShortcutHint, onComposerKeydown };
}
