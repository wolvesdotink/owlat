/**
 * Persisted popup-composer size (drag-to-resize).
 *
 * The chosen width/height is a per-device UI preference — like the folder-rail
 * collapse and toolbar preferences — so it persists via localStorage rather
 * than the Convex settings row. Reads and writes are clamped to the shared
 * min/max bounds so a resized-then-shrunk viewport (or a corrupt stored value)
 * can never yield an off-screen or sub-minimum composer.
 */
import {
	clampComposerSize,
	DEFAULT_COMPOSER_SIZE,
	type ComposerSize,
	type Viewport,
} from '~/utils/postboxComposerLayout';

const STORAGE_KEY = 'postbox-composer-size';

function currentViewport(): Viewport {
	if (!import.meta.client) {
		// SSR / test fallback: a large viewport so clamping never shrinks the
		// default below what the client would show.
		return { width: 4000, height: 4000 };
	}
	return { width: window.innerWidth, height: window.innerHeight };
}

export function usePostboxComposerSize() {
	const { data, set } = useLocalStorage<ComposerSize>(STORAGE_KEY, DEFAULT_COMPOSER_SIZE);

	// Always expose a clamped value so consumers can bind it to inline styles
	// unconditionally, even if the stored value predates a viewport change.
	const size = computed<ComposerSize>(() => clampComposerSize(data.value, currentViewport()));

	function setSize(next: Partial<ComposerSize>) {
		set(clampComposerSize({ ...size.value, ...next }, currentViewport()));
	}

	return { size, setSize };
}
