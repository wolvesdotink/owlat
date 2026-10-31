import { onScopeDispose, watch, type Ref } from 'vue';
import { isComposingKey } from '../utils/composingKey';

/**
 * A layer's Escape handler. Returning `false` declines the press: it goes on
 * to the page untouched (no layer underneath gets it either), for a layer that
 * only wants Escape in some states (Zen mode leaves text fields their Escape).
 */
type EscapeHandler = (event: KeyboardEvent) => boolean | void;

interface EscapeLayer {
	onEscape?: EscapeHandler;
}

// Open layers in the order they opened: the last one is the innermost.
const layers: EscapeLayer[] = [];

/**
 * One listener for every layer, in the window's capture phase: it runs before
 * any document or element listener, so the order components happened to
 * register in no longer decides who gets the key.
 */
function handleKeydown(event: KeyboardEvent) {
	if (event.key !== 'Escape' || isComposingKey(event) || event.defaultPrevented) return;
	const top = layers.at(-1);
	// A layer without a handler (a dialog that handles Escape itself) lets the
	// press through, and still keeps it from the layers underneath.
	if (!top?.onEscape) return;
	if (top.onEscape(event) === false) return;
	event.preventDefault();
	event.stopImmediatePropagation();
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
 *
 * `base` puts the layer underneath every other one, whenever it opened: a mode
 * that wraps the whole app (Zen) is left only once nothing above it is open.
 */
export function useEscapeLayer(
	active: Ref<boolean> | (() => boolean),
	onEscape?: EscapeHandler,
	options: { base?: boolean } = {}
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
			if (options.base) layers.unshift(layer);
			else layers.push(layer);
		},
		{ immediate: true }
	);
	onScopeDispose(() => remove(layer));
}
