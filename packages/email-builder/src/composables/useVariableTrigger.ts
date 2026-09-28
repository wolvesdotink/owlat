/**
 * The `{{` / `@` variable picker shared by the canvas `InlineTextEditor` and
 * the panel `RichTextEditor`.
 *
 * Split in two layers so the rules are testable without a browser:
 * - pure: {@link detectVariableTrigger} decides whether the text before the
 *   caret opens the picker and with which query;
 * - DOM: {@link removeTextRange}, {@link insertVariableChip} and
 *   {@link menuPosition} act on the live Selection.
 *
 * {@link useVariableTrigger} wires both into the picker state the editors
 * render through `VariablePickerMenu`.
 */

import { computed, ref, type Ref } from 'vue';
import type { Variable } from '../types';

interface VariableTriggerMatch {
	/** Offset of the trigger (`{{` or `@`) in the text node. */
	index: number;
	/** What the user typed after the trigger. */
	query: string;
}

/** Zero-width space placed after a chip so the caret has somewhere to land. */
const CARET_SPACER = '\u200B';

/**
 * Whether the text before `offset` ends in an open variable trigger.
 *
 * - `{{` opens the picker until a `}` closes it.
 * - `@` opens it only at the start or after whitespace, so `a@b` (an email
 *   address) does not.
 * - When both are present, the one closer to the caret wins.
 */
export function detectVariableTrigger(text: string, offset: number): VariableTriggerMatch | null {
	const beforeCaret = text.slice(0, offset);

	const braceOpen = /\{\{([^}]*)$/.test(beforeCaret);
	const braceIdx = braceOpen ? beforeCaret.lastIndexOf('{{') : -1;

	const atIdx = beforeCaret.lastIndexOf('@');
	const atValid = atIdx !== -1 && (atIdx === 0 || /\s/.test(beforeCaret[atIdx - 1]!));

	if (atValid && atIdx > braceIdx) return { index: atIdx, query: beforeCaret.slice(atIdx + 1) };
	if (braceIdx !== -1) return { index: braceIdx, query: beforeCaret.slice(braceIdx + 2) };
	return null;
}

/**
 * Remove the text from `start` up to the caret, or to the end of `node` when
 * the caret has left it, then put a collapsed caret back at `start`. Used to
 * strip the typed trigger (`{{na`, `@na`, `/hea`) before acting on a pick.
 */
export function removeTextRange(node: Node, start: number): void {
	const text = node.textContent ?? '';
	const selection = window.getSelection();
	const current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	const end = current && current.startContainer === node ? current.startOffset : text.length;

	node.textContent = text.slice(0, start) + text.slice(Math.max(end, start));

	if (selection && node.parentNode) {
		const caret = document.createRange();
		caret.setStart(node, Math.min(start, node.textContent.length));
		caret.collapse(true);
		selection.removeAllRanges();
		selection.addRange(caret);
	}
}

/**
 * Insert a non-editable `{{key}}` chip at the caret, followed by a zero-width
 * space so the caret lands after the chip rather than inside or before it.
 *
 * When `root` is given and the selection is not inside it (e.g. a toolbar
 * button was clicked before the editor was ever focused), the chip is
 * appended at the end of `root` instead of wherever the page selection is.
 */
export function insertVariableChip(
	variable: Pick<Variable, 'key'>,
	root?: HTMLElement | null
): HTMLSpanElement | null {
	const selection = window.getSelection();
	if (!selection) return null;

	let range: Range;
	if (
		selection.rangeCount > 0 &&
		(!root || root.contains(selection.getRangeAt(0).startContainer))
	) {
		range = selection.getRangeAt(0);
		range.deleteContents();
	} else if (root) {
		range = document.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
	} else {
		return null;
	}

	const chip = document.createElement('span');
	chip.className = 'variable-tag';
	chip.contentEditable = 'false';
	chip.dataset['variable'] = variable.key;
	chip.textContent = `{{${variable.key}}}`;
	range.insertNode(chip);

	const spacer = document.createTextNode(CARET_SPACER);
	range.setStartAfter(chip);
	range.insertNode(spacer);
	range.setStartAfter(spacer);
	range.setEndAfter(spacer);
	selection.removeAllRanges();
	selection.addRange(range);
	return chip;
}

/** Where to open a caret-anchored menu: just below the caret, relative to `wrapperEl`. */
export function menuPosition(wrapperEl: HTMLElement | null | undefined): {
	top: number;
	left: number;
} {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !wrapperEl) return { top: 0, left: 0 };
	const caretRect = selection.getRangeAt(0).getBoundingClientRect();
	const wrapperRect = wrapperEl.getBoundingClientRect();
	return {
		top: caretRect.bottom - wrapperRect.top + 4,
		left: caretRect.left - wrapperRect.left,
	};
}

interface UseVariableTriggerOptions {
	/** The variables the picker offers; the picker never opens when empty. */
	variables: () => Variable[] | undefined;
	/** Positioned ancestor the menu is placed in. */
	wrapperEl: Readonly<Ref<HTMLElement | null>>;
	/** Called after a chip was inserted, e.g. to re-emit the editor HTML. */
	onSelect?: (variable: Variable) => void;
}

export function useVariableTrigger(options: UseVariableTriggerOptions) {
	const open = ref(false);
	const query = ref('');
	const selectedIndex = ref(0);
	const position = ref({ top: 0, left: 0 });

	let triggerNode: Node | null = null;
	let triggerOffset = -1;

	const filteredVariables = computed(() => {
		const variables = options.variables();
		if (!variables?.length) return [];
		const q = query.value.toLowerCase();
		return variables.filter(
			(v) => v.key.toLowerCase().includes(q) || v.label.toLowerCase().includes(q)
		);
	});

	function close(): void {
		open.value = false;
		query.value = '';
		selectedIndex.value = 0;
		triggerNode = null;
		triggerOffset = -1;
	}

	/**
	 * Read the caret and open, update or close the picker. Returns whether the
	 * picker is open afterwards.
	 */
	function detect(): boolean {
		if (!options.variables()?.length) {
			if (open.value) close();
			return false;
		}
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return open.value;

		const range = selection.getRangeAt(0);
		const node = range.startContainer;
		const match =
			node.nodeType === Node.TEXT_NODE
				? detectVariableTrigger(node.textContent ?? '', range.startOffset)
				: null;
		if (!match) {
			if (open.value) close();
			return false;
		}

		if (!open.value) {
			triggerNode = node;
			triggerOffset = match.index;
			position.value = menuPosition(options.wrapperEl.value);
		}
		open.value = true;
		query.value = match.query;
		selectedIndex.value = 0;
		return true;
	}

	/** Strip the typed trigger, insert the chip and close the picker. */
	function select(variable: Variable): void {
		if (triggerNode && triggerOffset !== -1) removeTextRange(triggerNode, triggerOffset);
		insertVariableChip(variable);
		close();
		options.onSelect?.(variable);
	}

	/**
	 * Menu navigation. Returns true when the event was consumed. A picker with
	 * no matches is not shown, so it consumes nothing either.
	 */
	function handleKeydown(event: KeyboardEvent): boolean {
		const count = filteredVariables.value.length;
		if (!open.value || count === 0) return false;

		switch (event.key) {
			case 'ArrowDown':
				selectedIndex.value = Math.min(selectedIndex.value + 1, count - 1);
				break;
			case 'ArrowUp':
				selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
				break;
			case 'Enter':
			case 'Tab': {
				const picked = filteredVariables.value[selectedIndex.value];
				if (picked) select(picked);
				break;
			}
			case 'Escape':
				close();
				break;
			default:
				return false;
		}
		event.preventDefault();
		event.stopPropagation();
		return true;
	}

	return {
		open,
		query,
		selectedIndex,
		position,
		filteredVariables,
		detect,
		handleKeydown,
		select,
		close,
	};
}
