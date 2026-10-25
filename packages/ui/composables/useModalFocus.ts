import { nextTick, onScopeDispose, watch, type Ref } from 'vue';
import { tabbableIn } from '../utils/tabbable';
import { useEscapeLayer } from './useEscapeLayer';

// Nested dialogs suspend the parent trap until the child closes.
const activeDialogs: symbol[] = [];
// The tokens in `activeDialogs` that are focus layers, not dialogs: they
// suspend the trap below them but never keep a dialog from restoring focus.
const focusLayers = new Set<symbol>();

function removeLayer(token: symbol) {
	const index = activeDialogs.indexOf(token);
	if (index !== -1) activeDialogs.splice(index, 1);
}

/**
 * Whether a closing dialog gives focus back to its opener: only when no other
 * dialog is open above it, so a dialog closing underneath a confirmation does
 * not pull focus out of that confirmation. Focus layers above it do not count.
 * A popover opened inside the dialog goes away with it, and its own return
 * target (its trigger) goes with the dialog's DOM, so the dialog's opener is
 * the only place focus can go back to.
 */
function ownsRestore(token: symbol): boolean {
	const index = activeDialogs.indexOf(token);
	return index !== -1 && activeDialogs.slice(index + 1).every((other) => focusLayers.has(other));
}

/**
 * A layer that holds focus outside every dialog's DOM while it is active (a
 * popover rendered at the end of `<body>`). An open dialog's trap would see
 * focus outside its container and pull it back in, which also dismisses the
 * layer, so the trap stands aside until the layer closes, as for a nested
 * dialog. The layer keeps Tab inside itself; nothing else is done here (no
 * initial focus, no restore, no Escape), and unlike a nested dialog it does
 * not stop the dialog below from restoring focus when that dialog closes.
 */
export function useFocusLayer(active: Ref<boolean> | (() => boolean)): void {
	if (typeof window === 'undefined') return;
	const token = Symbol('focus layer');
	focusLayers.add(token);
	watch(
		active,
		(isActive) => {
			if (!isActive) removeLayer(token);
			else if (!activeDialogs.includes(token)) activeDialogs.push(token);
		},
		{ immediate: true }
	);
	onScopeDispose(() => {
		removeLayer(token);
		focusLayers.delete(token);
	});
}

export interface ModalFocusOptions {
	/**
	 * The element to focus on open instead of the first focusable one, e.g.
	 * Cancel on a destructive confirmation. Ignored when it is missing, outside
	 * the container or cannot take focus.
	 */
	initialFocus?: () => HTMLElement | null | undefined;
}

/** Capture, contain, and restore focus for a modal, including conditional unmounts. */
export function useModalFocus(
	container: Ref<HTMLElement | null>,
	active: Ref<boolean> | (() => boolean),
	onEscape?: () => void,
	options: ModalFocusOptions = {}
): void {
	if (typeof window === 'undefined') return;
	const token = Symbol('modal focus');
	let opener: HTMLElement | null = null;
	let generation = 0;
	const isTop = () => activeDialogs.at(-1) === token;
	const focusable = () => (container.value ? tabbableIn(container.value) : []);

	// Escape goes to the innermost open layer, which may be a menu or listbox
	// opened inside this dialog rather than the dialog itself.
	useEscapeLayer(active, onEscape);

	function handleKeydown(event: KeyboardEvent) {
		if (!isTop() || event.defaultPrevented) return;
		if (event.key !== 'Tab' || !container.value) return;
		const nodes = focusable();
		const first = nodes[0];
		const last = nodes.at(-1);
		const outside = !container.value.contains(document.activeElement);
		if (!first || !last) {
			event.preventDefault();
			container.value.focus();
		} else if (
			event.shiftKey &&
			(outside || document.activeElement === first || document.activeElement === container.value)
		) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (outside || document.activeElement === last)) {
			event.preventDefault();
			first.focus();
		}
	}

	/**
	 * Focus that is deliberately off the Tab order, on the panel itself or on a
	 * descendant with a negative tabindex (an intro heading as initial target),
	 * has no defined next stop, which the browser may place past the dialog's
	 * edge: Tab enters at the first control and Shift+Tab at the last. Anything
	 * else, a shadow host included, is left to the browser, which knows the
	 * order inside trees this code cannot see. This runs on the way back up, so
	 * a descendant that handles Tab itself (and prevents the default) keeps it.
	 */
	function handleOffOrderTab(event: KeyboardEvent) {
		if (!isTop() || event.defaultPrevented) return;
		if (event.key !== 'Tab' || !container.value) return;
		if (!container.value.contains(document.activeElement)) return;
		// Follow open shadow roots, so a host with tabindex="-1" whose inner
		// control holds focus is not taken for the off-order target itself.
		let current = document.activeElement;
		while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
		const offOrder =
			current === container.value ||
			(current instanceof HTMLElement && current.hasAttribute('tabindex') && current.tabIndex < 0);
		if (!offOrder) return;
		const nodes = focusable();
		const first = nodes[0];
		const last = nodes.at(-1);
		if (!first || !last) return;
		event.preventDefault();
		(event.shiftKey ? last : first).focus();
	}

	/**
	 * The requested target, else the first focusable descendant, else the
	 * container itself, which needs tabindex="-1" for that last step to land.
	 */
	function focusInitial() {
		const root = container.value;
		if (!root) return;
		const requested = options.initialFocus?.();
		const candidates = [requested, focusable()[0]].filter(
			(el): el is HTMLElement =>
				!!el && root.contains(el) && !el.closest('[hidden], [inert], [aria-hidden="true"]')
		);
		for (const el of [...candidates, root]) {
			el.focus();
			if (document.activeElement === el) return;
		}
	}

	function release() {
		generation += 1;
		const restore = ownsRestore(token);
		removeLayer(token);
		document.removeEventListener('keydown', handleKeydown, true);
		document.removeEventListener('keydown', handleOffOrderTab);
		if (restore && opener?.isConnected) opener.focus();
		opener = null;
	}

	watch(
		active,
		async (isActive) => {
			if (!isActive) {
				release();
				return;
			}
			opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			activeDialogs.push(token);
			document.addEventListener('keydown', handleKeydown, true);
			document.addEventListener('keydown', handleOffOrderTab);
			const current = ++generation;
			await nextTick();
			if (current !== generation || !isTop()) return;
			// Respect a component's deliberate initial target, e.g. a reader pane.
			if (container.value?.contains(document.activeElement)) return;
			focusInitial();
		},
		{ immediate: true }
	);

	onScopeDispose(release);
}
