/**
 * Run a composable the way a page does: inside a component's `setup`, so its
 * `onMounted`/`onUnmounted` hooks bind to an instance and its watchers to a
 * scope. Called bare, those hooks are dropped with a Vue warning and the test
 * exercises a composable that never installs its listeners.
 */
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';

export function withSetup<T>(factory: () => T): { result: T; unmount: () => void } {
	let result!: T;
	const wrapper = mount(
		defineComponent({
			setup() {
				result = factory();
				return () => null;
			},
		})
	);
	return { result, unmount: () => wrapper.unmount() };
}
