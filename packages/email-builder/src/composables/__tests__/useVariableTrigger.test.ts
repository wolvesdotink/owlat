// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
	detectVariableTrigger,
	insertVariableChip,
	removeTextRange,
	useVariableTrigger,
} from '../useVariableTrigger';
import type { Variable } from '../../types';

describe('detectVariableTrigger', () => {
	const cases: Array<[string, { index: number; query: string } | null]> = [
		['{{fi', { index: 0, query: 'fi' }],
		['Hi {{', { index: 3, query: '' }],
		['a @x', { index: 2, query: 'x' }],
		['@x', { index: 0, query: 'x' }],
		['a@b', null],
		['{{a @b', { index: 4, query: 'b' }],
		['@a {{b', { index: 3, query: 'b' }],
		['{{a}}', null],
		['{{a}} {{b', { index: 6, query: 'b' }],
		['plain text', null],
	];

	it.each(cases)('%j -> %j', (text, expected) => {
		expect(detectVariableTrigger(text, text.length)).toEqual(expected);
	});

	it('only reads the text before the caret', () => {
		expect(detectVariableTrigger('{{fi and more', 4)).toEqual({ index: 0, query: 'fi' });
		expect(detectVariableTrigger('ab {{x', 2)).toBeNull();
	});
});

function mountEditor(html: string): HTMLDivElement {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

function placeCaret(node: Node, offset: number) {
	const range = document.createRange();
	range.setStart(node, offset);
	range.collapse(true);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

function caret() {
	const range = window.getSelection()!.getRangeAt(0);
	return { node: range.startContainer, offset: range.startOffset, collapsed: range.collapsed };
}

afterEach(() => {
	document.body.innerHTML = '';
	window.getSelection()?.removeAllRanges();
});

describe('removeTextRange', () => {
	it('strips from start to the caret and puts the caret back at start', () => {
		const el = mountEditor('Hi {{na there');
		const text = el.firstChild!;
		placeCaret(text, 7);

		removeTextRange(text, 3);

		expect(el.textContent).toBe('Hi  there');
		expect(caret()).toEqual({ node: text, offset: 3, collapsed: true });
	});

	it('strips to the end of the node when the caret has moved elsewhere', () => {
		const el = mountEditor('Hi /hea<b>bold</b>');
		const text = el.firstChild!;
		placeCaret(el.querySelector('b')!.firstChild!, 2);

		removeTextRange(text, 3);

		expect(el.innerHTML).toBe('Hi <b>bold</b>');
		expect(caret()).toEqual({ node: text, offset: 3, collapsed: true });
	});
});

describe('insertVariableChip', () => {
	it('inserts the chip plus a zero-width spacer and leaves the caret after the spacer', () => {
		const el = mountEditor('Hi ');
		placeCaret(el.firstChild!, 3);

		const chip = insertVariableChip({ key: 'firstName' }, el);

		expect(chip).not.toBeNull();
		expect(chip!.className).toBe('variable-tag');
		expect(chip!.contentEditable).toBe('false');
		expect(chip!.dataset['variable']).toBe('firstName');
		expect(chip!.textContent).toBe('{{firstName}}');

		const spacer = chip!.nextSibling!;
		expect(spacer.nodeType).toBe(Node.TEXT_NODE);
		expect(spacer.textContent).toBe('\u200B');

		const { node, offset, collapsed } = caret();
		expect(collapsed).toBe(true);
		// The caret sits after the spacer: either at the end of the spacer text
		// node or on the parent right after it, depending on the DOM engine.
		const afterSpacer =
			(node === spacer && offset === 1) || (node === el && el.childNodes[offset - 1] === spacer);
		expect(afterSpacer).toBe(true);
	});

	it('appends to the root when the selection is outside it', () => {
		const outside = mountEditor('elsewhere');
		const el = mountEditor('Body');
		placeCaret(outside.firstChild!, 4);

		insertVariableChip({ key: 'plan' }, el);

		expect(outside.innerHTML).toBe('elsewhere');
		expect(el.querySelector('[data-variable="plan"]')).not.toBeNull();
		expect(el.firstChild!.textContent).toBe('Body');
	});
});

describe('useVariableTrigger', () => {
	const variables: Variable[] = [
		{ key: 'firstName', label: 'First name' },
		{ key: 'lastName', label: 'Last name' },
		{ key: 'email', label: 'Email' },
	];

	function key(k: string) {
		return new KeyboardEvent('keydown', { key: k, cancelable: true, bubbles: true });
	}

	function openPicker(text: string, onSelect?: (v: Variable) => void) {
		const el = mountEditor(text);
		placeCaret(el.firstChild!, text.length);
		const picker = useVariableTrigger({
			variables: () => variables,
			wrapperEl: ref(el),
			onSelect,
		});
		expect(picker.detect()).toBe(true);
		return { el, picker };
	}

	it('clamps the selected index to the filtered list', () => {
		const { picker } = openPicker('Hi {{');
		expect(picker.filteredVariables.value).toHaveLength(3);

		for (let i = 0; i < 5; i++) expect(picker.handleKeydown(key('ArrowDown'))).toBe(true);
		expect(picker.selectedIndex.value).toBe(2);

		for (let i = 0; i < 5; i++) picker.handleKeydown(key('ArrowUp'));
		expect(picker.selectedIndex.value).toBe(0);
	});

	it('consumes navigation keys and leaves other keys alone', () => {
		const { picker } = openPicker('Hi {{');
		const down = key('ArrowDown');
		expect(picker.handleKeydown(down)).toBe(true);
		expect(down.defaultPrevented).toBe(true);

		const letter = key('a');
		expect(picker.handleKeydown(letter)).toBe(false);
		expect(letter.defaultPrevented).toBe(false);

		expect(picker.handleKeydown(key('Escape'))).toBe(true);
		expect(picker.open.value).toBe(false);
		expect(picker.handleKeydown(key('ArrowDown'))).toBe(false);
	});

	it('does not swallow keys while no variable matches', () => {
		const { picker } = openPicker('write to @nobody');
		expect(picker.open.value).toBe(true);
		expect(picker.filteredVariables.value).toHaveLength(0);

		const enter = key('Enter');
		expect(picker.handleKeydown(enter)).toBe(false);
		expect(enter.defaultPrevented).toBe(false);
	});

	it('replaces the typed trigger with a chip on Enter', () => {
		const onSelect = vi.fn();
		const { el, picker } = openPicker('Hi {{last', onSelect);
		expect(picker.query.value).toBe('last');
		expect(picker.filteredVariables.value.map((v) => v.key)).toEqual(['lastName']);

		expect(picker.handleKeydown(key('Enter'))).toBe(true);

		expect(el.innerHTML).toBe(
			'Hi <span class="variable-tag" contenteditable="false" data-variable="lastName">{{lastName}}</span>\u200B'
		);
		expect(picker.open.value).toBe(false);
		expect(onSelect).toHaveBeenCalledWith(variables[1]);
	});

	it('never opens without variables', () => {
		const el = mountEditor('Hi {{');
		placeCaret(el.firstChild!, 5);
		const picker = useVariableTrigger({ variables: () => [], wrapperEl: ref(el) });
		expect(picker.detect()).toBe(false);
		expect(picker.open.value).toBe(false);
	});
});
