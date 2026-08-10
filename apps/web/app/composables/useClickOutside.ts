import type { ComponentPublicInstance, Ref } from 'vue';

/**
 * What a template ref can hold: a DOM element, or — when `ref=` sits on a
 * component (`<UiButton ref="triggerEl">`) — that component's public instance,
 * whose rendered root node is `$el`. Accepting both means a consumer can swap a
 * raw `<button>` for a component without the containment check silently
 * breaking (a component instance is truthy but has no `.contains`, which used to
 * throw on every document click and leave the panel stuck open).
 */
type ClickOutsideTarget = Ref<HTMLElement | ComponentPublicInstance | null | undefined>;

/** Anything with `contains()` — an Element, Document or DocumentFragment. */
function isContainerNode(value: unknown): value is Node {
	return !!value && typeof (value as Node).contains === 'function';
}

/** Resolve a template ref's current value to the node to test containment on. */
function resolveNode(value: ClickOutsideTarget['value']): Node | null {
	if (!value) return null;
	if (isContainerNode(value)) return value;
	const root = (value as ComponentPublicInstance).$el as unknown;
	return isContainerNode(root) ? root : null;
}

/**
 * Run a handler when a click lands outside the given element(s).
 *
 * Replaces the hand-rolled `document.addEventListener('click', …)` +
 * matching `removeEventListener` in `onMounted`/`onUnmounted` that several
 * dropdown menus repeated. The page keeps only "what closes" — the listener
 * lifecycle and the contains() check live here.
 *
 * Pass one element ref or several (e.g. a trigger and its panel); the handler
 * fires only when the click is outside all of them.
 */
export function useClickOutside(
	target: ClickOutsideTarget | ClickOutsideTarget[],
	handler: (event: MouseEvent) => void
): void {
	const targets = Array.isArray(target) ? target : [target];

	const onClick = (event: MouseEvent) => {
		const node = event.target as Node | null;
		if (!node) return;
		const isInside = targets.some((t) => resolveNode(t.value)?.contains(node));
		if (!isInside) handler(event);
	};

	onMounted(() => document.addEventListener('click', onClick));
	onUnmounted(() => document.removeEventListener('click', onClick));
}

/**
 * Selector flavor of `useClickOutside` for v-for dropdown instances (table
 * rows, card grids) where collecting element refs is more ceremony than the
 * data-attribute the rows already carry. Fires the handler when a click lands
 * outside any element matching `selector`.
 */
export function useClickOutsideSelector(
	selector: string,
	handler: (event: MouseEvent) => void
): void {
	const onClick = (event: MouseEvent) => {
		const node = event.target as HTMLElement | null;
		if (node && !node.closest(selector)) handler(event);
	};

	onMounted(() => document.addEventListener('click', onClick));
	onUnmounted(() => document.removeEventListener('click', onClick));
}
