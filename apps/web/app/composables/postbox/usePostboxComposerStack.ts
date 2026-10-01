/**
 * Manages up to 3 simultaneous popup composers (Gmail-style).
 *
 * Each entry holds a one-time seed for usePostboxCompose (ComposerSeed).
 */

import type { ComposerSeed } from './usePostboxCompose';

/**
 * On a plain Reply, the recipients a Reply-All would additionally include
 * (raw address strings). Drives the dismissible "Also include …" gap hint
 * under the To field. Empty/undefined on Reply-All, forwards, and new mail.
 */
interface ReplyAllHint {
	replyAllRecipients?: string[];
}

/** A popup composer on the stack: its seed plus the stack's bookkeeping. */
export type ComposerSpec = ComposerSeed &
	ReplyAllHint & {
		id: string;
		minimized: boolean;
	};

const MAX_COMPOSERS = 3;

export function usePostboxComposerStack() {
	const state = useState<ComposerSpec[]>('postbox:composer-stack', () => []);

	// The newest still-open (non-minimized) composer, or null when none is
	// expanded (the mobile tab bar hides while one is).
	const activeComposerId = computed<string | null>(() => {
		for (let i = state.value.length - 1; i >= 0; i--) {
			const c = state.value[i]!;
			if (!c.minimized) return c.id;
		}
		return null;
	});

	function open(spec: Omit<ComposerSpec, 'id' | 'minimized'>): string {
		if (state.value.length >= MAX_COMPOSERS) {
			// Replace the oldest minimized composer to make room
			const oldestMinimized = state.value.findIndex((c) => c.minimized);
			if (oldestMinimized >= 0) {
				state.value.splice(oldestMinimized, 1);
			} else {
				return state.value[state.value.length - 1]!.id;
			}
		}
		const id = `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
		state.value = [...state.value, { id, minimized: false, ...spec }];
		return id;
	}

	function close(id: string) {
		state.value = state.value.filter((c) => c.id !== id);
	}

	function minimize(id: string) {
		state.value = state.value.map((c) => (c.id === id ? { ...c, minimized: true } : c));
	}

	/**
	 * Bring a docked composer back to a floating popup: un-minimize it AND move
	 * it to the end of the stack so it counts as one of the newest (and so wins a
	 * popup slot back from an overflow it had been pushed into). Used by the dock
	 * chip restore.
	 */
	function bringToFront(id: string) {
		const spec = state.value.find((c) => c.id === id);
		if (!spec) return;
		state.value = [...state.value.filter((c) => c.id !== id), { ...spec, minimized: false }];
	}

	return {
		state,
		activeComposerId,
		open,
		close,
		minimize,
		bringToFront,
	};
}
