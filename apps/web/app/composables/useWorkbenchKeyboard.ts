import { onBeforeUnmount, onMounted } from 'vue';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import type { TodayChange, TodayLine } from '~/utils/todayDigest';

interface WorkbenchKeyboardActions {
	/** Every line the Workbench shows, in reading order. */
	lines: () => readonly (TodayLine | TodayChange)[];
	/** While the peek panel is open it owns the keys. */
	peekOpen: () => boolean;
	open: (line: TodayLine | TodayChange) => void;
	done: (line: TodayLine | TodayChange) => void;
	replyAnyway: (line: TodayLine) => void;
}

/**
 * The Workbench's keys: j/k move between lines, Enter opens the peek, d marks
 * a line done (and moves on), r sends a team-inbox update to the Answer queue.
 * Lines are found by their `data-today-key` attribute, so focus follows the
 * rendered order whatever the column layout.
 */
export function useWorkbenchKeyboard(actions: WorkbenchKeyboardActions) {
	function onKeydown(event: KeyboardEvent) {
		if (actions.peekOpen() || event.metaKey || event.ctrlKey || event.altKey) return;
		if (isEditableTarget(event.target)) return;
		const all = Array.from(document.querySelectorAll<HTMLElement>('[data-today-key]'));
		if (all.length === 0) return;
		const active = document.activeElement?.closest<HTMLElement>('[data-today-key]') ?? null;
		const index = active ? all.indexOf(active) : -1;
		if (event.key === 'j' || event.key === 'k') {
			event.preventDefault();
			const next = event.key === 'j' ? Math.min(all.length - 1, index + 1) : Math.max(0, index - 1);
			all[next]?.focus();
			return;
		}
		if (!active) return;
		const line = actions.lines().find((l) => l.key === active.dataset['todayKey']);
		if (!line) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			actions.open(line);
		} else if (event.key === 'd') {
			event.preventDefault();
			all[index + 1]?.focus();
			actions.done(line);
		} else if (event.key === 'r' && 'inboundMessageId' in line && line.inboundMessageId) {
			event.preventDefault();
			actions.replyAnyway(line);
		}
	}
	onMounted(() => window.addEventListener('keydown', onKeydown));
	onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
}
