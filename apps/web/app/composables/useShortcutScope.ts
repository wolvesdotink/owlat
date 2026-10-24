import { onBeforeMount, onBeforeUnmount, ref, watch } from 'vue';
import type { ShortcutScope } from '~/utils/shortcutRegistry';
import { pushShortcutScope } from '~/utils/shortcutScope';

/**
 * Claim a shortcut scope while the calling component is mounted and `active`
 * says so: the scope's chords resolve before the app-wide ones, its entries
 * appear on the "?" sheet, and both go away the moment the surface does.
 *
 * The claim starts in `onBeforeMount`, not `onMounted`: a parent's
 * before-mount runs before its children are created, while children finish
 * mounting first. Claiming in `onMounted` would put a panel that is open on
 * load (the Workbench peek from a `?peek=` link) UNDER the page that hosts it,
 * and the page would answer the panel's keys. Client-only by construction,
 * and released through the idempotent handle `pushShortcutScope` returns, so a
 * watcher and an unmount racing each other cannot release twice.
 */
export function useShortcutScope(scope: ShortcutScope, active: () => boolean = () => true): void {
	const live = ref(false);
	let release: (() => void) | null = null;

	watch(
		() => live.value && active(),
		(on) => {
			if (on && !release) release = pushShortcutScope(scope);
			else if (!on && release) {
				release();
				release = null;
			}
		},
		// Synchronous, so the scope is live in the same tick the surface mounts
		// or opens: the very next keypress resolves against it.
		{ flush: 'sync' }
	);

	onBeforeMount(() => {
		live.value = true;
	});
	onBeforeUnmount(() => {
		live.value = false;
		release?.();
		release = null;
	});
}
