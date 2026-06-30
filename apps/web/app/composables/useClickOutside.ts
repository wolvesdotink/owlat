import type { Ref } from 'vue';

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
	target: Ref<HTMLElement | null | undefined> | Array<Ref<HTMLElement | null | undefined>>,
	handler: (event: MouseEvent) => void,
): void {
	const targets = Array.isArray(target) ? target : [target];

	const onClick = (event: MouseEvent) => {
		const node = event.target as Node | null;
		if (!node) return;
		const isInside = targets.some((t) => t.value?.contains(node));
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
	handler: (event: MouseEvent) => void,
): void {
	const onClick = (event: MouseEvent) => {
		const node = event.target as HTMLElement | null;
		if (node && !node.closest(selector)) handler(event);
	};

	onMounted(() => document.addEventListener('click', onClick));
	onUnmounted(() => document.removeEventListener('click', onClick));
}
