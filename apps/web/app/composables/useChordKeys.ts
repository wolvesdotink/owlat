import type { ComputedRef } from 'vue';
import { formatChord } from '~/utils/shortcutRegistry';

/**
 * A chord's key labels for this machine, as the cheat sheet prints them:
 * `mod+Enter` is ⌘ Enter on a Mac and Ctrl Enter everywhere else. A browser on a Mac
 * gets the ⌘ too, not only the desktop app.
 */
export function useChordKeys(chord: string): ComputedRef<string[]> {
	const { platform } = useDesktopContext();
	return computed(() => formatChord(chord, !import.meta.server && platform.value === 'mac'));
}
