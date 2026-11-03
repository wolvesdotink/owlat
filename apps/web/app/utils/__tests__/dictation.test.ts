/**
 * A dictated phrase goes in at the caret like typed text: spaced from the word
 * before it, over a selection, within the field's length limit, and announced
 * with `input` so the field's model takes it.
 */
import { describe, expect, it, vi } from 'vitest';
import { insertDictated, insertIntoTextField, spaceDictated } from '../dictation';

function field(value: string, caret: number, end = caret, maxLength?: number) {
	const input = document.createElement('input');
	if (maxLength !== undefined) input.maxLength = maxLength;
	input.value = value;
	input.setSelectionRange(caret, end);
	return input;
}

describe('spaceDictated', () => {
	it('spaces a phrase from the word before it, not from a space or the start', () => {
		expect(spaceDictated('Thursday works', 'ask for the agenda')).toBe(' ask for the agenda');
		expect(spaceDictated('Thursday works ', ' ask for the agenda')).toBe('ask for the agenda');
		expect(spaceDictated('', ' Thursday works')).toBe('Thursday works');
		expect(spaceDictated('works', '   ')).toBe('');
	});
});

describe('insertIntoTextField', () => {
	it('writes at the caret and tells the field it changed', () => {
		const input = field('Thursday  agenda', 9);
		const onInput = vi.fn();
		input.addEventListener('input', onInput);
		insertIntoTextField(input, 'works, ask for the');
		expect(input.value).toBe('Thursday works, ask for the agenda');
		expect(input.selectionStart).toBe('Thursday works, ask for the'.length);
		expect(onInput).toHaveBeenCalledTimes(1);
	});

	it('replaces a selection', () => {
		const input = field('tell them Friday', 10, 16);
		insertIntoTextField(input, 'Thursday');
		expect(input.value).toBe('tell them Thursday');
	});

	it('stops at the field length limit', () => {
		const input = field('Thursday', 8, 8, 14);
		insertIntoTextField(input, 'works for us');
		expect(input.value).toBe('Thursday works');
	});

	it('leaves a full field alone, without an input event', () => {
		const input = field('Thursday', 8, 8, 8);
		const onInput = vi.fn();
		input.addEventListener('input', onInput);
		insertIntoTextField(input, 'works');
		expect(input.value).toBe('Thursday');
		expect(onInput).not.toHaveBeenCalled();
	});
});

describe('insertDictated', () => {
	it('hands an editor the phrase through its own insertText', () => {
		const insertText = vi.fn();
		insertDictated({ insertText }, 'Thursday works');
		expect(insertText).toHaveBeenCalledWith('Thursday works');
	});

	it('writes into a textarea directly', () => {
		const textarea = document.createElement('textarea');
		insertDictated(textarea, 'Thursday works');
		expect(textarea.value).toBe('Thursday works');
	});
});
