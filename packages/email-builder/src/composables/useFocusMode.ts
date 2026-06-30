import { ref, onMounted, onUnmounted } from 'vue';

/**
 * Composable for managing focus mode state in email editors.
 * Focus mode hides sidebar, header, and all UI chrome for distraction-free editing.
 *
 * Keyboard shortcuts:
 * - Cmd/Ctrl+Shift+F: Toggle focus mode
 * - Escape: Exit focus mode (when active)
 */

// Module-level shared state - ensures all usages of useFocusMode() share the same state
const isFocusMode = ref(false);

export function useFocusMode() {
	const enterFocusMode = () => {
		isFocusMode.value = true;
	};

	const exitFocusMode = () => {
		isFocusMode.value = false;
	};

	const toggleFocusMode = () => {
		isFocusMode.value = !isFocusMode.value;
	};

	const setupKeyboardShortcut = () => {
		if (typeof window === 'undefined') return;

		const handleKeyDown = (event: KeyboardEvent) => {
			// Escape key exits focus mode
			if (event.key === 'Escape' && isFocusMode.value) {
				event.preventDefault();
				exitFocusMode();
				return;
			}

			// Cmd/Ctrl+Shift+F toggles focus mode
			const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
			const modifier = isMac ? event.metaKey : event.ctrlKey;

			if (modifier && event.shiftKey && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				toggleFocusMode();
			}
		};

		onMounted(() => {
			document.addEventListener('keydown', handleKeyDown);
		});

		onUnmounted(() => {
			document.removeEventListener('keydown', handleKeyDown);
			isFocusMode.value = false;
		});
	};

	return {
		isFocusMode,
		enterFocusMode,
		exitFocusMode,
		toggleFocusMode,
		setupKeyboardShortcut,
	};
}
