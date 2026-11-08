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
 * move between rows (j/k), open shows the peek (Enter), done marks a line
 * done and moves on (d), reply sends a team-inbox update to the Answer queue
 * (r). Rows are found by their `data-today-key` attribute, so focus follows
 * the rendered order whatever the column layout.
 *
 * The work cards of "What needs you" are rows too (`data-today-key="work:…"`,
 * TodayWork.vue), first in reading order. On a card the keys use the card's
 * own controls: Enter opens it, r takes its next step (Reply, or Open), and d
 * ticks off a task card; so a key does exactly what its button does.
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

	/** The focused work card, when focus is on one. */
	function activeCard(): HTMLElement | null {
		const row = activeRow();
		return row?.dataset['todayKey']?.startsWith('work:') ? row : null;
	}
	const cardControl = (name: 'open' | 'step' | 'complete') =>
		activeCard()?.querySelector<HTMLElement>(`[data-work-key="${name}"]`) ?? null;

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
	function focusNext() {
		const all = rows();
		const row = activeRow();
		all[(row ? all.indexOf(row) : -1) + 1]?.focus();
	}

	registerShortcut({
		id: 'workbench.open',
		handler: () => {
			const card = cardControl('open');
			if (card) return card.click();
			const line = activeLine();
			if (line) actions.open(line);
		},
		when: () => free() && (cardControl('open') !== null || activeLine() !== null),
	});
	registerShortcut({
		id: 'workbench.done',
		handler: () => {
			const complete = cardControl('complete');
			if (complete) {
				focusNext();
				return complete.click();
			}
			const line = activeLine();
			if (!line) return;
			focusNext();
			actions.done(line);
		},
		when: () => free() && (cardControl('complete') !== null || activeLine() !== null),
	});
	registerShortcut({
		id: 'workbench.reply',
		handler: () => {
			const step = cardControl('step');
			if (step) return step.click();
			const line = activeLine();
			if (line && 'inboundMessageId' in line && line.inboundMessageId) actions.replyAnyway(line);
		},
		when: () => {
			if (!free()) return false;
			if (cardControl('step') !== null) return true;
			const line = activeLine();
			return line !== null && 'inboundMessageId' in line && !!line.inboundMessageId;
		},
	});
}
