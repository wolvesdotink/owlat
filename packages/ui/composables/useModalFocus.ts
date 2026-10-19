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
	 * Focus inside the dialog but off the Tab order (the panel itself, a
	 * tabindex="-1" initial target) has no defined next stop, which the browser
	 * may place past the dialog's edge: Tab enters at the first control and
	 * Shift+Tab at the last. This runs on the way back up, so a descendant that
	 * handles Tab itself (and prevents the default) keeps it.
	 */
	function handleOffOrderTab(event: KeyboardEvent) {
		if (!isTop() || event.defaultPrevented) return;
		if (event.key !== 'Tab' || !container.value) return;
		const current = document.activeElement;
		if (!(current instanceof HTMLElement) || !container.value.contains(current)) return;
		const nodes = focusable();
		const first = nodes[0];
		const last = nodes.at(-1);
		if (!first || !last || nodes.includes(current) || inShadowTabOrder(current)) return;
		event.preventDefault();
		(event.shiftKey ? last : first).focus();
	}

	/** Focus on a tabbable element inside `host`'s shadow tree, where the browser owns the order. */
	function inShadowTabOrder(host: HTMLElement): boolean {
		let deep: Element = host;
		while (deep.shadowRoot?.activeElement) deep = deep.shadowRoot.activeElement;
		// The deep element holds focus, so it is neither hidden nor inert.
		return (
			deep !== host && deep instanceof HTMLElement && (deep.tabIndex >= 0 || deep.isContentEditable)
		);
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
