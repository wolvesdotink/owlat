/**
 * Where a dictated phrase goes in a plain text field, and the space in front
 * of it. The speech engine itself is `useSpeechDictation`'s.
 */

/** A field, or anything else that takes dictated text at its caret. */
export type DictationTarget =
	| HTMLInputElement
	| HTMLTextAreaElement
	| { insertText: (text: string) => void };

/**
 * The phrase as it goes in after `before` (the text left of the caret): a
 * space in front unless it starts the field or follows whitespace. Engines
 * hand back phrases with and without their own leading space.
 */
export function spaceDictated(before: string, phrase: string): string {
	const text = phrase.trim();
	if (!text || before === '' || /\s$/.test(before)) return text;
	return ` ${text}`;
}

/**
 * Put a phrase into an input or textarea at its caret, over any selection,
 * without moving focus. `setRangeText` ignores `maxlength`, so the phrase is
 * cut to what the field still takes. The `input` event lets a `v-model` or an
 * `@input` handler take it like typed text.
 */
export function insertIntoTextField(
	field: HTMLInputElement | HTMLTextAreaElement,
	phrase: string
): void {
	const start = field.selectionStart ?? field.value.length;
	const end = field.selectionEnd ?? start;
	let text = spaceDictated(field.value.slice(0, start), phrase);
	if (field.maxLength >= 0) {
		text = text.slice(0, Math.max(0, field.maxLength - (field.value.length - (end - start))));
	}
	if (!text) return;
	field.setRangeText(text, start, end);
	field.setSelectionRange(start + text.length, start + text.length);
	field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Send a phrase to its target: a text field, or an editor's own `insertText`. */
export function insertDictated(target: DictationTarget, phrase: string): void {
	if ('insertText' in target) target.insertText(phrase);
	else insertIntoTextField(target, phrase);
}
