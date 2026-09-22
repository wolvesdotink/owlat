import { nextTick, onScopeDispose, watch, type Ref } from 'vue';

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

// Nested dialogs suspend the parent trap until the child closes.
const activeDialogs: symbol[] = [];

/** Capture, contain, and restore focus for a modal, including conditional unmounts. */
export function useModalFocus(
	container: Ref<HTMLElement | null>,
	active: Ref<boolean> | (() => boolean),
	onEscape?: () => void
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

	function handleKeydown(event: KeyboardEvent) {
		if (!isTop() || event.defaultPrevented) return;
		if (event.key === 'Escape' && onEscape) {
			event.preventDefault();
			event.stopImmediatePropagation();
			onEscape();
			return;
		}
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
			(focusable()[0] ?? container.value)?.focus();
		},
		{ immediate: true }
	);

	onScopeDispose(release);
}
