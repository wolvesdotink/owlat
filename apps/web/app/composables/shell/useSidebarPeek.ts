/**
 * The hidden sidebar's peek: the rail slides back over the content while the
 * pointer is at the left edge or on it, and goes again when the pointer or
 * focus leaves or Esc is pressed.
 */
import type { Ref } from 'vue';

export function useSidebarPeek(options: {
	isPeeking: Readonly<Ref<boolean>>;
	openPeek: () => void;
	closePeek: () => void;
}) {
	const { isPeeking, openPeek, closePeek } = options;

	// Peek overlay: open on left-edge hover, close 300ms after the pointer leaves
	// (cancelled if it returns), or immediately on Esc / focus leaving the rail.
	const peekCloseTimer = ref<ReturnType<typeof setTimeout> | null>(null);
	const cancelPeekClose = () => {
		if (peekCloseTimer.value !== null) {
			clearTimeout(peekCloseTimer.value);
			peekCloseTimer.value = null;
		}
	};
	const schedulePeekClose = () => {
		cancelPeekClose();
		peekCloseTimer.value = setTimeout(() => {
			closePeek();
			peekCloseTimer.value = null;
		}, 300);
	};
	const onPeekPointerEnter = () => {
		cancelPeekClose();
		openPeek();
	};
	const onPeekPointerLeave = () => {
		// Only meaningful while a peek is open; ignore ordinary visible/collapsed leaves.
		if (!isPeeking.value) return;
		schedulePeekClose();
	};
	// Focus leaving the peeked rail (Tab out / click away) closes it.
	const onPeekFocusOut = (e: FocusEvent) => {
		const next = e.relatedTarget as Node | null;
		const current = e.currentTarget as HTMLElement | null;
		if (!current || (next && current.contains(next))) return;
		closePeek();
	};
	// Esc closes the peek without un-hiding the sidebar.
	const onPeekKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && isPeeking.value) {
			e.stopPropagation();
			closePeek();
		}
	};
	onUnmounted(cancelPeekClose);

	return { onPeekPointerEnter, onPeekPointerLeave, onPeekFocusOut, onPeekKeydown };
}
