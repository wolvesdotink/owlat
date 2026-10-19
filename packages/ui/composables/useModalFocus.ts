import { nextTick, onScopeDispose, watch, type Ref } from 'vue';
import { useEscapeLayer } from './useEscapeLayer';

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// Nested dialogs suspend the parent trap until the child closes.
const activeDialogs: symbol[] = [];

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
	const focusable = () =>
		Array.from(container.value?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
			(el) =>
				!el.closest('[hidden], [inert], [aria-hidden="true"]') &&
				(el.tabIndex >= 0 || el.getAttribute('contenteditable') === 'true')
		);

	// Escape goes to the innermost open layer, which may be a menu or listbox
	// opened inside this dialog rather than the dialog itself.
	useEscapeLayer(active, onEscape);

	function handleKeydown(event: KeyboardEvent) {
		if (!isTop() || event.defaultPrevented) return;
		if (event.key !== 'Tab' || !container.value) return;
		const nodes = focusable();
		const first = nodes[0];
		const last = nodes.at(-1);
		const current = document.activeElement;
		// Outside the dialog, or on something inside it that Tab order skips (the
		// panel itself, a tabindex="-1" initial target): the browser's next stop
		// could be past the dialog's edge, so Tab enters at the first control and
		// Shift+Tab at the last.
		const offOrder = !(current instanceof HTMLElement) || !nodes.includes(current);
		if (!first || !last) {
			event.preventDefault();
			container.value.focus();
		} else if (event.shiftKey && (offOrder || current === first)) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (offOrder || current === last)) {
			event.preventDefault();
			first.focus();
		}
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
		const restore = isTop();
		const index = activeDialogs.indexOf(token);
		if (index !== -1) activeDialogs.splice(index, 1);
		document.removeEventListener('keydown', handleKeydown, true);
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
