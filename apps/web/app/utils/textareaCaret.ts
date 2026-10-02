/**
 * Where a character offset of a textarea sits on screen, relative to the
 * textarea's own top-left corner (scrolling accounted for), so a dropdown can
 * be anchored under the caret the way the rich editor anchors one under its
 * DOM range.
 *
 * A textarea exposes no geometry for its text, so a hidden mirror `<div>` with
 * the same box and font metrics lays the text out again up to the offset and a
 * marker `<span>` there is measured. DOM-only; returns null outside a browser.
 */

/** The styles that decide where text wraps and how tall a line is. */
const MIRRORED = [
	'boxSizing',
	'width',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'borderTopWidth',
	'borderRightWidth',
	'borderBottomWidth',
	'borderLeftWidth',
	'fontFamily',
	'fontSize',
	'fontWeight',
	'fontStyle',
	'letterSpacing',
	'lineHeight',
	'textTransform',
	'wordSpacing',
	'tabSize',
] as const;

export function textareaCaretOffset(
	textarea: HTMLTextAreaElement,
	offset: number
): { left: number; top: number; height: number } | null {
	if (typeof document === 'undefined') return null;
	const style = window.getComputedStyle(textarea);
	const mirror = document.createElement('div');
	for (const prop of MIRRORED) mirror.style[prop] = style[prop];
	mirror.style.position = 'absolute';
	mirror.style.visibility = 'hidden';
	mirror.style.whiteSpace = 'pre-wrap';
	mirror.style.overflowWrap = 'break-word';
	mirror.style.top = '0';
	mirror.style.left = '-9999px';
	mirror.textContent = textarea.value.slice(0, offset);
	const marker = document.createElement('span');
	marker.textContent = textarea.value.slice(offset, offset + 1) || '.';
	mirror.appendChild(marker);
	document.body.appendChild(mirror);
	const lineHeight = Number.parseFloat(style.lineHeight) || marker.offsetHeight;
	const position = {
		left: marker.offsetLeft - textarea.scrollLeft,
		top: marker.offsetTop - textarea.scrollTop,
		height: lineHeight,
	};
	mirror.remove();
	return position;
}
