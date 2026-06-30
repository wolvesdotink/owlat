/**
 * Minimal IMAP4rev1 line parser.
 *
 * Real-world IMAP supports literals (e.g. `LOGIN user {7}\r\npassword`)
 * and complex token structures; this parser handles the subset needed
 * for the read-only command set (LOGIN, LIST, SELECT, FETCH, IDLE, NOOP,
 * LOGOUT, CAPABILITY, ID, NAMESPACE, ENABLE, UNSELECT). Non-literal
 * commands are tokenized at whitespace, with `"quoted strings"` and
 * `(parenthesized lists)` preserved as opaque tokens.
 *
 * Literals (RFC 3501 §4.3 / LITERAL+ RFC 7888) span multiple lines: the
 * pump (`connection.ts`) absorbs the `{N}` octets per `matchTrailingLiteral`,
 * then reassembles the whole command via `parseCommandWithLiterals`, which
 * splices each absorbed literal value back as a single token.
 *
 * Returns:
 *   { tag, command, args }
 *
 * For LOGIN-style commands the password may arrive as a `{n}+` literal
 * — the caller should provide the full buffered line including the
 * literal contents.
 */

export interface ParsedCommand {
	tag: string;
	command: string;
	args: string[];
}

/**
 * Tokenize one IMAP text segment (no literals) into top-level tokens,
 * honouring `"quoted strings"` and `(parenthesized lists)`. Shared by
 * `parseLine` (the whole-line path) and `parseCommandWithLiterals` (the
 * literal-continuation path), so both treat quotes/parens identically.
 */
function tokenizeSegment(line: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	let token = '';
	let depth = 0; // paren nesting

	const flush = () => {
		if (token.length > 0) {
			tokens.push(token);
			token = '';
		}
	};

	while (i < line.length) {
		const ch = line[i];

		// Quoted string
		if (ch === '"' && depth === 0 && token.length === 0) {
			let end = i + 1;
			let value = '';
			while (end < line.length) {
				const c = line[end];
				if (c === '\\' && end + 1 < line.length) {
					value += line[end + 1];
					end += 2;
					continue;
				}
				if (c === '"') break;
				value += c;
				end += 1;
			}
			tokens.push(value);
			i = end + 1;
			continue;
		}

		// Parenthesized list — keep as a single opaque token
		if (ch === '(' && depth === 0) {
			depth = 1;
			token += '(';
			i += 1;
			continue;
		}
		if (depth > 0) {
			if (ch === '(') depth += 1;
			if (ch === ')') depth -= 1;
			token += ch;
			i += 1;
			if (depth === 0) flush();
			continue;
		}

		// Whitespace separates tokens at the top level
		if (ch === ' ' || ch === '\t') {
			flush();
			i += 1;
			continue;
		}

		token += ch;
		i += 1;
	}
	flush();
	return tokens;
}

export function parseLine(raw: string): ParsedCommand | null {
	const line = raw.replace(/\r?\n$/, '');
	if (line.length === 0) return null;

	const tokens = tokenizeSegment(line);

	const [tag, command, ...args] = tokens;
	if (tag === undefined || command === undefined) return null;
	return { tag, command: command.toUpperCase(), args };
}

/**
 * Match a trailing IMAP literal declaration (`{N}` or `{N+}` for
 * LITERAL+ per RFC 7888) at the very end of a command segment. The
 * literal must be the last thing on the line — anything after the
 * closing brace means it is not a continuation point.
 *
 * Returns the declared octet count and whether it is a LITERAL+ (no
 * continuation `+ ` required), or `null` when the segment does not end
 * in a literal.
 */
export function matchTrailingLiteral(
	segment: string,
): { octets: number; literalPlus: boolean } | null {
	const m = segment.match(/\{(\d+)(\+?)\}$/);
	if (!m) return null;
	const octets = parseInt(m[1] ?? '', 10);
	if (Number.isNaN(octets)) return null;
	return { octets, literalPlus: m[2] === '+' };
}

/**
 * Assemble a `ParsedCommand` from a command spread across literal
 * continuations (RFC 3501 §4.3). The pump strips the trailing `{N}` /
 * `{N+}` token off each text segment, absorbs the declared octets as a
 * literal, and collects the pieces:
 *
 *   segments[0] {N0}  literals[0]  segments[1] {N1}  literals[1]  segments[2]
 *
 * `segments.length === literals.length + 1`. Each literal value is a
 * single opaque token (IMAP literals stand in for one astring/string);
 * the text segments around them are tokenized normally so quoted strings
 * and paren lists keep working. Used for non-APPEND literals like
 * `LOGIN {n}` passwords; APPEND keeps its own byte-streaming path.
 */
export function parseCommandWithLiterals(
	segments: string[],
	literals: string[],
): ParsedCommand | null {
	const tokens: string[] = [];
	for (let idx = 0; idx < segments.length; idx += 1) {
		const seg = segments[idx] ?? '';
		// A literal that abuts a non-space prefix (e.g. `LOGIN user{8}`
		// with no space) would otherwise be glued onto the previous token.
		// IMAP literals are whitespace-separated tokens in practice, so we
		// tokenize the text then push the literal as its own token.
		for (const t of tokenizeSegment(seg)) tokens.push(t);
		if (idx < literals.length) {
			const lit = literals[idx];
			if (lit !== undefined) tokens.push(lit);
		}
	}

	const [tag, command, ...args] = tokens;
	if (tag === undefined || command === undefined) return null;
	return { tag, command: command.toUpperCase(), args };
}

/** Strip the surrounding parentheses from a `(...)` token. */
export function unwrapParens(token: string): string {
	if (token.startsWith('(') && token.endsWith(')')) {
		return token.slice(1, -1);
	}
	return token;
}

/** Tokenize a parenthesized list (`(FLAGS UID INTERNALDATE)` → ['FLAGS','UID','INTERNALDATE']). */
export function parseList(token: string): string[] {
	return unwrapParens(token)
		.split(/\s+/)
		.filter(Boolean);
}

/** Parse an IMAP UID range like `1:* 5,7,10:12` into an array of [low, high] pairs. */
export function parseUidSet(spec: string, maxUid: number): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const part of spec.split(',')) {
		const [a, b] = part.split(':');
		const low = a === '*' ? maxUid : parseInt(a ?? '', 10);
		const high = b === undefined ? low : b === '*' ? maxUid : parseInt(b, 10);
		if (Number.isNaN(low) || Number.isNaN(high)) continue;
		ranges.push([Math.min(low, high), Math.max(low, high)]);
	}
	return ranges;
}
