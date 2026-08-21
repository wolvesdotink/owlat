/**
 * Which shell geometry the Postbox three-pane layout uses:
 *
 *   - 'three' — the desktop folder rail / list / reader side by side (lg+).
 *   - 'stack' — below lg: single column. The rail becomes a slide-over drawer,
 *     the list fills the width, and an opened message renders as a full-screen
 *     reader overlay instead of the third pane.
 *
 * The keyboard model, listbox semantics and all triage behavior are identical
 * in both modes — this only changes geometry, exactly like the existing
 * Today↔Browse landing-mode switch. SSR renders 'three' (the pre-existing
 * layout) and hydrates to 'stack' on small screens; a one-frame desktop
 * layout on a phone is imperceptible next to hydration itself.
 */

export type PostboxPaneMode = 'three' | 'stack';

const STACK_QUERY = '(max-width: 1023px)';

export function usePostboxPaneMode() {
	const mode = ref<PostboxPaneMode>('three');

	if (import.meta.client) {
		const query = window.matchMedia(STACK_QUERY);
		const apply = () => {
			mode.value = query.matches ? 'stack' : 'three';
		};
		apply();
		query.addEventListener('change', apply);
		onScopeDispose(() => query.removeEventListener('change', apply));
	}

	return { mode: readonly(mode), isStack: computed(() => mode.value === 'stack') };
}
