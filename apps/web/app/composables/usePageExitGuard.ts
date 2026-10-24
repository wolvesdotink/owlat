import { onMounted, onUnmounted } from 'vue';
import { registerReloadBlocker } from '~/lib/reloadBlockers';

/**
 * While the calling component is mounted and `dirty()` answers true, leaving
 * the document would lose edits: the browser asks before the tab closes or
 * reloads, and an app update does not reload the page on its own.
 *
 * Every `beforeunload` warning in the app goes through here. A warning the
 * update gate does not know about would let an update reload start, then
 * stop at the browser's prompt with the page still open.
 */
export function usePageExitGuard(dirty: () => boolean): void {
	const onBeforeUnload = (event: BeforeUnloadEvent) => {
		if (!dirty()) return;
		event.preventDefault();
		event.returnValue = '';
	};
	let unregister: (() => void) | undefined;

	onMounted(() => {
		window.addEventListener('beforeunload', onBeforeUnload);
		unregister = registerReloadBlocker(dirty);
	});
	onUnmounted(() => {
		window.removeEventListener('beforeunload', onBeforeUnload);
		unregister?.();
	});
}
