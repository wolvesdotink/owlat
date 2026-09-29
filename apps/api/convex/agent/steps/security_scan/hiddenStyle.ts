/**
 * Whether an inline `style` attribute hides its element, read the way the
 * browser reads it: character references in the attribute value are decoded
 * first, then CSS comments are dropped and CSS backslash escapes decoded. Used
 * by the security scan's hidden-markup strip (`hiddenMarkup.ts`). Every step is
 * one linear pass over the value.
 */

/**
 * An inline style that hides its element: display:none, visibility:hidden,
 * font-size:0, opacity:0, or white / transparent text. The negative lookbehind
 * keeps `background-color: white` visible. The `rgba(` arguments are
 * length-bounded so a long unterminated value cannot backtrack.
 */
const HIDING_STYLE =
	/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?(?![.\d])|opacity\s*:\s*0(?:\.0+)?(?![.\d])|(?<![-\w])color\s*:\s*(?:white|transparent|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]{0,64},\s*0(?:\.0+)?\s*\))/i;

/**
 * The named character references that stand for ASCII punctuation or spacing a
 * style could be spelled with. Letters and digits have no named references.
 */
const NAMED_REFERENCES: Record<string, string> = {
	amp: '&',
	apos: "'",
	ast: '*',
	bsol: '\\',
	colon: ':',
	comma: ',',
	commat: '@',
	dollar: '$',
	equals: '=',
	excl: '!',
	grave: '`',
	gt: '>',
	hat: '^',
	lbrace: '{',
	lbrack: '[',
	lcub: '{',
	lowbar: '_',
	lpar: '(',
	lsqb: '[',
	lt: '<',
	newline: '\n',
	num: '#',
	percnt: '%',
	period: '.',
	plus: '+',
	quest: '?',
	quot: '"',
	rbrace: '}',
	rbrack: ']',
	rcub: '}',
	rpar: ')',
	rsqb: ']',
	semi: ';',
	sol: '/',
	tab: '\t',
	verbar: '|',
	vert: '|',
};

/** A decoded numeric reference; the browser turns invalid ones into U+FFFD. */
function codePointText(code: number): string {
	if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return '\uFFFD';
	if (code >= 0xd800 && code <= 0xdfff) return '\uFFFD';
	return String.fromCodePoint(code);
}

const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([a-zA-Z]{2,8});)/g;

/** Decode the character references in an attribute value, as the tokenizer does. */
function decodeAttributeValue(value: string): string {
	if (!value.includes('&')) return value;
	return value.replace(
		CHARACTER_REFERENCE,
		(match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
			if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
			if (dec !== undefined) return codePointText(Number.parseInt(dec, 10));
			return NAMED_REFERENCES[(name as string).toLowerCase()] ?? match;
		}
	);
}

/**
 * A CSS comment (an unclosed one runs to the end, as in CSS) or a backslash
 * escape: hex digits with one optional trailing space, an escaped newline, or
 * any other escaped character.
 */
const CSS_COMMENT_OR_ESCAPE =
	/\/\*[\s\S]*?(?:\*\/|$)|\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g;

/**
 * A style declaration as CSS reads it: comments dropped and backslash escapes
 * decoded (`\6e one` and `n\one` both read `none`).
 */
function normalizeCss(style: string): string {
	if (!style.includes('\\') && !style.includes('/*')) return style;
	return style.replace(
		CSS_COMMENT_OR_ESCAPE,
		(_match, hex: string | undefined, _newline: string | undefined, char: string | undefined) => {
			if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
			// An escaped character stands for itself; comments and escaped
			// newlines read as nothing.
			return char ?? '';
		}
	);
}

/** Whether a raw `style` attribute value hides its element. */
export function styleHides(rawStyle: string): boolean {
	return HIDING_STYLE.test(normalizeCss(decodeAttributeValue(rawStyle)));
}

/** A style that takes the element out of the rendering: display:none or visibility:hidden. */
const REMOVING_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;

/**
 * Whether a raw `style` attribute value removes its element from view. Text
 * colour does not count here: it applies to the document element and body of
 * dark-themed mail, which is readable on its own background.
 */
export function styleRemoves(rawStyle: string): boolean {
	return REMOVING_STYLE.test(normalizeCss(decodeAttributeValue(rawStyle)));
}
