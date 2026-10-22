/**
 * Auto-unmount for @vue/test-utils wrappers, shared by the vitest setups of this
 * layer and of apps/web.
 *
 * `enableAutoUnmount` unmounts every wrapper the test created, including the
 * ones the test already unmounted itself, and a second `app.unmount()` re-runs
 * the app's cleanup callbacks: an `attachTo` mount then removes its host node
 * from a parent it has already left and throws. Each wrapper's `unmount` is
 * made a no-op after its first successful call, so an explicit unmount in a
 * test and the automatic one after it compose.
 */
import { config, enableAutoUnmount } from '@vue/test-utils';

/**
 * Unmount every wrapper after each test, passed or failed. Call it once per
 * test file, from the vitest setup: @vue/test-utils throws on a second call.
 */
export function enableAutoUnmountOnce(afterEachHook: (cleanup: () => void) => void): void {
	config.plugins.VueWrapper.install((wrapper) => {
		const unmount = wrapper.unmount.bind(wrapper);
		let unmounted = false;
		return {
			unmount() {
				if (unmounted) return;
				unmount();
				unmounted = true;
			},
		};
	});
	enableAutoUnmount(afterEachHook);
}
