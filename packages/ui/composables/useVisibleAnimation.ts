import { onScopeDispose, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue';
import { observeVisibleAnimation } from '../utils/visibleAnimation';

/**
 * Component adapter for `observeVisibleAnimation`: registers the element behind
 * a template ref while `active` is true, and unregisters it when the ref goes
 * away (a `v-if` branch unmounts), `active` turns false, or the owning scope is
 * disposed. Flushes after render so the ref already points at the new element.
 */
export function useVisibleAnimation(
	target: Readonly<Ref<HTMLElement | null | undefined>>,
	active: MaybeRefOrGetter<boolean> = true
): void {
	let release: (() => void) | null = null;
	const unregister = (): void => {
		release?.();
		release = null;
	};

	watch(
		() => (toValue(active) ? target.value : null),
		(element) => {
			unregister();
			if (element) release = observeVisibleAnimation(element);
		},
		{ immediate: true, flush: 'post' }
	);
	onScopeDispose(unregister);
}
