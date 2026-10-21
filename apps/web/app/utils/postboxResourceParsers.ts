/**
 * The linear parsers behind the Postbox remote-resource gate
 * (`postboxRemoteResources.ts`): inline-style declarations, the CSS functions
 * inside them, and `srcset` candidates.
 *
 * Every input here is attacker-controlled mail, so each parser is a single
 * forward pass (no anchored or backtracking regex over the input), and the CSS
 * tokenizer reads escapes, strings and nesting the way the browser does, so
 * what it reports is what the iframe would fetch. Each takes an optional
 * `ScanWork` meter and adds the characters its loops visited, so the tests can
 * hold hostile input to linear work by counting instead of timing.
 */

import type { ScanWork } from '@owlat/shared/postboxTrackers';

/**
 * Split an inline style into declarations on top-level `;`, honouring quotes,
 * parentheses and backslash escapes, so a `;` inside `url("…")` stays put.
 */
export function splitStyleDeclarations(style: string, work?: ScanWork): string[] {
	const declarations: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	let visits = 0;
	for (let i = 0; i < style.length; i++) {
		visits++;
		const ch = style[i];
		if (ch === '\\') {
			i++;
			continue;
		}
		if (quote) {
			// A newline ends a CSS string (as a bad string) just like its quote.
			if (ch === quote || isCssNewline(ch)) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		else if (ch === ';' && depth === 0) {
			declarations.push(style.slice(start, i));
			start = i + 1;
		}
	}
	declarations.push(style.slice(start));
	// The blank-declaration filter reads every declaration once more.
	if (work) work.chars += visits + style.length;
	return declarations.filter((declaration) => declaration.trim() !== '');
}

/**
 * A top-level CSS function in one declaration (`url(…)`, `image-set(…)`,
 * `-webkit-cross-fade(…)`, anything) and every URL it could fetch.
 */
export interface CssFunctionUnit {
	start: number;
	end: number;
	urls: string[];
}

function isCssNewline(ch: string | undefined): boolean {
	return ch === '\n' || ch === '\r' || ch === '\f';
}

function isCssWhitespace(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || isCssNewline(ch);
}

function isCssIdentChar(ch: string): boolean {
	return /[\w-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/** A `\` at `at` starts an escape unless a newline follows it. */
function isCssEscape(value: string, at: number): boolean {
	return value[at] === '\\' && !isCssNewline(value[at + 1]);
}

/**
 * Decode the escape whose `\` is at `at` (CSS Syntax 4.3.7): 1-6 hex digits
 * plus one optional whitespace, or the next character as itself. Out-of-range
 * code points and a trailing `\` read as U+FFFD, as the browser reads them.
 */
function decodeCssEscape(value: string, at: number): { text: string; next: number } {
	let i = at + 1;
	if (i >= value.length) return { text: '\uFFFD', next: i };
	let hex = '';
	while (hex.length < 6 && i < value.length && /[\da-f]/i.test(value[i]!)) hex += value[i++];
	if (hex) {
		if (value[i] === '\r' && value[i + 1] === '\n') i += 2;
		else if (isCssWhitespace(value[i])) i++;
		const code = Number.parseInt(hex, 16);
		const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
		return { text: valid ? String.fromCodePoint(code) : '\uFFFD', next: i };
	}
	const ch = String.fromCodePoint(value.codePointAt(i)!);
	return { text: ch, next: i + ch.length };
}

/** Read the quoted string opening at `at`, escapes decoded. */
function readCssString(value: string, at: number): { text: string; next: number } {
	const quote = value[at];
	let text = '';
	let i = at + 1;
	while (i < value.length) {
		const ch = value[i]!;
		if (ch === quote) return { text, next: i + 1 };
		// An unescaped newline ends the string (the browser drops it as bad).
		if (isCssNewline(ch)) return { text, next: i };
		if (ch === '\\') {
			if (isCssNewline(value[i + 1])) {
				// A line continuation.
				i += value[i + 1] === '\r' && value[i + 2] === '\n' ? 3 : 2;
				continue;
			}
			if (i + 1 >= value.length) break;
			const escape = decodeCssEscape(value, i);
			text += escape.text;
			i = escape.next;
			continue;
		}
		text += ch;
		i++;
	}
	return { text, next: i };
}

/** Read the identifier starting at `at`, escapes decoded. */
function readCssIdent(value: string, at: number): { name: string; next: number } {
	let name = '';
	let i = at;
	while (i < value.length) {
		if (isCssEscape(value, i)) {
			const escape = decodeCssEscape(value, i);
			name += escape.text;
			i = escape.next;
		} else if (isCssIdentChar(value[i]!)) {
			name += value[i++];
		} else {
			break;
		}
	}
	return { name, next: i };
}

/**
 * Tokenize one declaration in a single linear pass and collect, per
 * top-level function, every reference the browser could fetch. Rather than
 * know which functions take images (and miss a nesting such as
 * `cross-fade(image-set("…"))`), it fails closed: every `url(…)` token and
 * every quoted string inside a function, at any depth, counts, except a
 * string directly inside `type()`, which names a MIME type. A quoted string
 * outside every function (a `font-family` name) is never fetched. Escapes are
 * decoded the way the browser decodes them, so `\75 rl(…)` is a `url(…)` and
 * `\23 000` is just a colour. Comments are skipped; an unterminated string,
 * comment or function runs to the end.
 */
export function cssFunctionUnits(value: string, work?: ScanWork): CssFunctionUnit[] {
	const units: CssFunctionUnit[] = [];
	// Characters visited: one per main-loop pass plus the span of every
	// sub-read (comment, string, identifier, url token) from where it started.
	let visits = 0;
	const stack: string[] = [];
	const length = value.length;
	// The top-level function being read, if any.
	const current: { unit: CssFunctionUnit | null } = { unit: null };
	const open = (name: string, at: number) => {
		if (stack.length === 0) current.unit = { start: at, end: length, urls: [] };
		stack.push(name);
	};
	const close = (end: number) => {
		stack.pop();
		if (stack.length === 0 && current.unit) {
			current.unit.end = end;
			units.push(current.unit);
			current.unit = null;
		}
	};
	let i = 0;
	while (i < length) {
		visits++;
		const ch = value[i]!;
		if (ch === '/' && value[i + 1] === '*') {
			const end = value.indexOf('*/', i + 2);
			visits += (end === -1 ? length : end + 2) - i;
			i = end === -1 ? length : end + 2;
		} else if (ch === '"' || ch === "'") {
			const string = readCssString(value, i);
			visits += string.next - i;
			if (current.unit && stack[stack.length - 1] !== 'type') {
				current.unit.urls.push(string.text.trim());
			}
			i = string.next;
		} else if (ch === '(') {
			open('', i);
			i++;
		} else if (ch === ')') {
			if (stack.length > 0) close(i + 1);
			i++;
		} else if (isCssIdentChar(ch) || isCssEscape(value, i)) {
			const ident = readCssIdent(value, i);
			visits += ident.next - i;
			if (value[ident.next] !== '(') {
				i = ident.next;
				continue;
			}
			const name = ident.name.toLowerCase();
			open(name, i);
			i = ident.next + 1;
			if (name !== 'url') continue;
			let k = i;
			while (k < length && isCssWhitespace(value[k])) k++;
			visits += k - i;
			if (value[k] === '"' || value[k] === "'") continue;
			// An unquoted url token runs to the next `)`, escapes decoded.
			const urlStart = k;
			let url = '';
			while (k < length && value[k] !== ')') {
				if (isCssEscape(value, k)) {
					const escape = decodeCssEscape(value, k);
					url += escape.text;
					k = escape.next;
				} else {
					url += value[k++];
				}
			}
			visits += k - urlStart;
			current.unit?.urls.push(url.trim());
			close(Math.min(k + 1, length));
			i = k + 1;
		} else {
			i++;
		}
	}
	if (current.unit) units.push(current.unit);
	if (work) work.chars += visits;
	return units;
}

/**
 * The `srcset` candidates: each one's URL and its full text (URL plus
 * descriptors). A candidate's URL runs to the next whitespace (so a `data:`
 * URL keeps its comma); trailing commas end it.
 */
export function srcsetCandidates(
	srcset: string,
	work?: ScanWork
): Array<{ url: string; text: string }> {
	const candidates: Array<{ url: string; text: string }> = [];
	// Characters visited by every loop below, the backward comma scan included.
	let visits = 0;
	let i = 0;
	while (i < srcset.length) {
		const gap = i;
		while (i < srcset.length && /[\s,]/.test(srcset[i]!)) i++;
		visits += i - gap + 1;
		if (i >= srcset.length) break;
		const start = i;
		let end = i;
		while (end < srcset.length && !/\s/.test(srcset[end]!)) end++;
		visits += end - i;
		let url = srcset.slice(i, end);
		i = end;
		if (url.endsWith(',')) {
			// A backward scan: `/,+$/` rescans every inner run of commas.
			let stop = url.length;
			while (stop > 0 && url[stop - 1] === ',') stop--;
			visits += url.length - stop + 1;
			url = url.slice(0, stop);
			if (url) candidates.push({ url, text: url });
			continue;
		}
		// The descriptors run up to the comma that ends this candidate.
		let depth = 0;
		const descriptors = i;
		while (i < srcset.length && !(srcset[i] === ',' && depth === 0)) {
			if (srcset[i] === '(') depth++;
			else if (srcset[i] === ')') depth = Math.max(0, depth - 1);
			i++;
		}
		visits += i - descriptors + 1;
		if (url) candidates.push({ url, text: srcset.slice(start, i).trim() });
	}
	if (work) work.chars += visits;
	return candidates;
}
