/**
 * The one HTML→plain-text conversion: stored snippets, thread previews, search
 * excerpts, AI prompts, security scans, the outbound `text/plain` part and the
 * MTA's text fallback all read a message through this function, so the same
 * message turns into the same words everywhere.
 *
 * It is a text extractor, not a renderer. It:
 *  - drops `<script>`, `<style>` and `<head>` elements with their content, and
 *    HTML comments (including Outlook's `<!--[if mso]>` blocks);
 *  - removes every remaining tag;
 *  - decodes the common named entities (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`
 *    `&nbsp;`) and every numeric one (`&#39;`, `&#x27;`) in ONE pass, so
 *    `&amp;lt;` becomes the text `&lt;`, not `<`.
 *
 * Two layouts:
 *  - default: tags become spaces and all whitespace collapses to single spaces,
 *    the shape a snippet, a search excerpt or a prompt wants;
 *  - `preserveBreaks: true`: the readable plain-text alternative. `<br>`,
 *    `</div>`, `</li>` and `</tr>` become a newline, `</p>` and `</h1-6>` a
 *    blank line, other tags vanish, and three or more newlines squeeze to two.
 *
 * Every regex here is linear in the input: no nested or overlapping
 * quantifiers, and every tag pattern either always succeeds from its `<` or
 * stops at the next `<`, so a hostile body of `<<<<…` or `<script` repeated
 * cannot make a scan quadratic. Raw-text elements are skipped with a forward
 * scan instead of a lazy `[\s\S]*?` per opening tag.
 *
 * Dependency-free on purpose: `@owlat/shared` (which re-exports this as
 * `@owlat/shared/html`) depends on this package, so this module cannot import
 * shared back, and it must run unchanged in V8 Convex functions, Node and the
 * browser.
 */

export interface HtmlToPlainTextOptions {
	/** Keep block structure as newlines instead of collapsing to one line. */
	preserveBreaks?: boolean;
}

/** Opening of a comment or of an element whose content is never visible text. */
const HIDDEN_OPEN = /<!--|<(script|style|head)(?=[\s/>])/gi;

/** Closing tag per hidden element (`\s*` only; the name is fixed). */
const HIDDEN_CLOSE: Record<string, RegExp> = {
	script: /<\/script\s*>/gi,
	style: /<\/style\s*>/gi,
	head: /<\/head\s*>/gi,
};

/**
 * Any tag: `<` followed by what HTML treats as a tag start (a letter, `/`, `!`
 * or `?`), through the next `>` — or to the end of the input, the way a browser
 * swallows an unterminated tag. Always succeeding from its `<` keeps it linear.
 * A `<` before anything else (`a < b`, `<3`) is text and stays.
 */
const TAG = /<[a-zA-Z/!?][^>]*(?:>|$)/g;

const LINE_BREAK_TAG = /<br\b[^<>]*>|<\/(?:div|li|tr)\s*>/gi;
const PARAGRAPH_END_TAG = /<\/(?:p|h[1-6])\s*>/gi;

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi;

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

/** A numeric reference as a character; invalid code points become U+FFFD. */
function fromCodePoint(code: number): string {
	// &#160; is a non-breaking space, which reads as a space exactly like &nbsp;.
	if (code === 0xa0) return ' ';
	if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
	return String.fromCodePoint(code);
}

function decodeEntities(text: string): string {
	return text.replace(
		ENTITY,
		(_m, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
			if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10));
			if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
			return NAMED_ENTITIES[(named as string).toLowerCase()] as string;
		}
	);
}

/**
 * Remove comments and `<script>`/`<style>`/`<head>` elements in one forward
 * pass. An unterminated comment, script or style runs to the end of the input,
 * as it does in a browser; an unterminated `<head>` only loses its own tag
 * (browsers close it implicitly at `<body>`, so its content cannot be skipped
 * safely).
 */
function dropHiddenContent(html: string, replacement: string): string {
	const pieces: string[] = [];
	let kept = 0;
	// Once a close tag is missing after some position it is missing after every
	// later one too; remembering that keeps `<head><head>…` linear.
	const missingClose = new Set<string>();
	HIDDEN_OPEN.lastIndex = 0;
	for (let open = HIDDEN_OPEN.exec(html); open; open = HIDDEN_OPEN.exec(html)) {
		const start = open.index;
		let end: number;
		const name = open[1]?.toLowerCase();
		if (name === undefined) {
			// `<!-->` and `<!--->` are complete (empty) comments, so look for the
			// terminator from just after `<!`.
			const close = html.indexOf('-->', start + 2);
			end = close === -1 ? html.length : close + 3;
		} else {
			const closeRe = HIDDEN_CLOSE[name] as RegExp;
			const from = start + open[0].length;
			let close: RegExpExecArray | null = null;
			if (!missingClose.has(name)) {
				closeRe.lastIndex = from;
				close = closeRe.exec(html);
				if (!close) missingClose.add(name);
			}
			if (close) {
				end = close.index + close[0].length;
			} else if (name === 'head') {
				continue;
			} else {
				end = html.length;
			}
		}
		pieces.push(html.slice(kept, start), replacement);
		kept = end;
		HIDDEN_OPEN.lastIndex = end;
	}
	if (kept === 0) return html;
	pieces.push(html.slice(kept));
	return pieces.join('');
}

/** Visible text of an HTML fragment. See the module header for the rules. */
export function htmlToPlainText(html: string, options: HtmlToPlainTextOptions = {}): string {
	if (!html) return '';
	if (options.preserveBreaks) {
		const text = dropHiddenContent(html, '')
			.replace(LINE_BREAK_TAG, '\n')
			.replace(PARAGRAPH_END_TAG, '\n\n')
			.replace(TAG, '');
		return decodeEntities(text)
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}
	const text = dropHiddenContent(html, ' ').replace(TAG, ' ');
	return decodeEntities(text).replace(/\s+/g, ' ').trim();
}
