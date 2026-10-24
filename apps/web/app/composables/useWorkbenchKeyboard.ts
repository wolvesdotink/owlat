import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { useShortcutScope } from '~/composables/useShortcutScope';
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
 * The Workbench's keys, as catalog ids in the `workbench` scope: next/previous
 * move between lines (j/k), open shows the peek (Enter), done marks a line
 * done and moves on (d), reply sends a team-inbox update to the Answer queue
 * (r). Lines are found by their `data-today-key` attribute, so focus follows
 * the rendered order whatever the column layout.
 *
 * Each command says when it can run (`when`), so a press it cannot act on is
 * left alone rather than swallowed, exactly as before the keys were remappable.
 */
export function useWorkbenchKeyboard(actions: WorkbenchKeyboardActions) {
	useShortcutScope('workbench');
	const { registerShortcut } = useKeyboardShortcuts();

	const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-today-key]'));
	const activeRow = () => document.activeElement?.closest<HTMLElement>('[data-today-key]') ?? null;
	function activeLine() {
		const row = activeRow();
		if (!row) return null;
		return actions.lines().find((l) => l.key === row.dataset['todayKey']) ?? null;
	}
	const free = () => !actions.peekOpen();

	function move(delta: 1 | -1) {
		const all = rows();
		const active = activeRow();
		const index = active ? all.indexOf(active) : -1;
		const next = delta === 1 ? Math.min(all.length - 1, index + 1) : Math.max(0, index - 1);
		all[next]?.focus();
	}

	registerShortcut({
		id: 'workbench.next',
		handler: () => move(1),
		when: () => free() && rows().length > 0,
	});
	registerShortcut({
		id: 'workbench.previous',
		handler: () => move(-1),
		when: () => free() && rows().length > 0,
	});
	registerShortcut({
		id: 'workbench.open',
		handler: () => {
			const line = activeLine();
			if (line) actions.open(line);
		},
		when: () => free() && activeLine() !== null,
	});
	registerShortcut({
		id: 'workbench.done',
		handler: () => {
			const line = activeLine();
			if (!line) return;
			const all = rows();
			const row = activeRow();
			all[(row ? all.indexOf(row) : -1) + 1]?.focus();
			actions.done(line);
		},
		when: () => free() && activeLine() !== null,
	});
	registerShortcut({
		id: 'workbench.reply',
		handler: () => {
			const line = activeLine();
			if (line && 'inboundMessageId' in line && line.inboundMessageId) actions.replyAnyway(line);
		},
		when: () => {
			if (!free()) return false;
			const line = activeLine();
			return line !== null && 'inboundMessageId' in line && !!line.inboundMessageId;
		},
	});
}
