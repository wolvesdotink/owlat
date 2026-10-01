import { onScopeDispose, watch, type Ref } from 'vue';

interface EscapeLayer {
	onEscape?: () => void;
}

// Open layers in the order they opened: the last one is the innermost.
const layers: EscapeLayer[] = [];

/**
 * One listener for every layer, in the window's capture phase: it runs before
 * any document or element listener, so the order components happened to
 * register in no longer decides who gets the key.
 */
function handleKeydown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
	const top = layers.at(-1);
	// A layer without a handler (a dialog that handles Escape itself) lets the
	// press through, and still keeps it from the layers underneath.
	if (!top?.onEscape) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	top.onEscape();
}

function remove(layer: EscapeLayer) {
	const index = layers.indexOf(layer);
	if (index === -1) return;
	layers.splice(index, 1);
	if (layers.length === 0) window.removeEventListener('keydown', handleKeydown, true);
}

/**
 * Escape closes the innermost open layer, and only that one.
 *
 * Dialogs, menus, listboxes and popovers register here while they are open.
 * A menu opened inside a modal is newer than the modal, so the first Escape
 * closes the menu and the second the modal; the press never reaches page-level
 * shortcuts while a layer handles it.
 */
export function useEscapeLayer(
	active: Ref<boolean> | (() => boolean),
	onEscape?: () => void
): void {
	if (typeof window === 'undefined') return;
	const layer: EscapeLayer = { onEscape };
	watch(
		active,
		(isActive) => {
			if (!isActive) {
				remove(layer);
				return;
			}
			if (layers.includes(layer)) return;
			if (layers.length === 0) window.addEventListener('keydown', handleKeydown, true);
			layers.push(layer);
		},
		{ immediate: true }
	);
	onScopeDispose(() => remove(layer));
}
