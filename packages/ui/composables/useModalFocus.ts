import { nextTick, onUnmounted, watch, type Ref } from 'vue';

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus management: when `active` flips on, remember the opener, move
 * focus into `container` (first focusable child, else the container itself —
 * give it tabindex="-1"), and trap Tab inside; when it flips off, restore
 * focus to the opener. Shared by UiModal and the chat dialog shell so every
 * overlay gets the same keyboard behavior instead of each hand-rolling (or
 * skipping) it.
 *
 * `onEscape` is invoked on the Escape key while active (pass undefined to
 * opt out, e.g. for persistent dialogs).
 */
export function useModalFocus(
	container: Ref<HTMLElement | null>,
	active: Ref<boolean> | (() => boolean),
	onEscape?: () => void,
): void {
	if (typeof window === 'undefined') return;

	let previouslyFocused: HTMLElement | null = null;

	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && onEscape) {
			onEscape();
			return;
		}

		if (event.key === 'Tab' && container.value) {
			const focusable = Array.from(
				container.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
			);
			if (focusable.length === 0) return;

			const first = focusable[0]!;
			const last = focusable[focusable.length - 1]!;

			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	};

	watch(
		active,
		async (isActive) => {
			if (isActive) {
				previouslyFocused = document.activeElement as HTMLElement | null;
				document.addEventListener('keydown', handleKeydown);

				await nextTick();
				if (container.value) {
					const firstFocusable =
						container.value.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
					(firstFocusable ?? container.value).focus();
				}
			} else {
				document.removeEventListener('keydown', handleKeydown);
				if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
					previouslyFocused.focus();
					previouslyFocused = null;
				}
			}
		},
		{ immediate: true },
	);

	onUnmounted(() => {
		document.removeEventListener('keydown', handleKeydown);
	});
}
