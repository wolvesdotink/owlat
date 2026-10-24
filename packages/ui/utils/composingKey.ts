/**
 * An IME is composing: its Enter confirms a candidate, its arrows pick one,
 * its Escape cancels the composition. Safari sends the confirming key after
 * `compositionend`, with `isComposing` already false but still `keyCode` 229.
 */
export function isComposingKey(event: KeyboardEvent): boolean {
	return event.isComposing || event.keyCode === 229;
}
