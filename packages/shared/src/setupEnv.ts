/**
 * Setup-time `.env` read / parse / merge / write helpers.
 *
 * NODE-ONLY: uses `node:fs`. Shared by the `owlat-setup` CLI (`apps/setup-cli`)
 * and the web setup endpoint (`apps/web/server/api/setup/apply.post.ts`) so the
 * two can never drift on how `.env` files are parsed or serialized. Exposed via
 * the `@owlat/shared/setupEnv` subpath ONLY — it must never be re-exported from
 * the `.` barrel, which has to stay browser-safe.
 *
 * Reading follows docker compose's `.env` rules (see {@link parseEnvContent}):
 * what these helpers read is pushed to the Convex deployment and shown by the
 * setup tools, so it has to be what compose hands the containers. On write,
 * values that need it are double-quoted with `\`, `"` and `$` escaped (see
 * {@link formatEnvValue}), so compose and {@link readEnvFile} both read back
 * exactly the value written. Insertion order is preserved.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export type EnvMap = Record<string, string>;

export async function readEnvFile(path: string): Promise<EnvMap> {
	if (!existsSync(path)) return {};
	return parseEnvContent(await readFile(path, 'utf-8'));
}

/** Whitespace as compose's dotenv parser sees it within a line (no `\n`). */
const INLINE_SPACE = new Set(['\t', '\v', '\f', '\r', ' ', '\u0085', '\u00a0']);
/** Characters compose accepts in a variable name besides letters and digits. */
const KEY_PUNCTUATION = new Set(['_', '.', '-', '[', ']']);
/** The escape sequences compose expands inside a double-quoted value. */
const DOUBLE_QUOTE_ESCAPE = /\\(?:[abcfnrtv$"\\]|0\d{0,3})/g;
const SIMPLE_ESCAPES: Record<string, string> = {
	a: '\x07',
	b: '\b',
	f: '\f',
	n: '\n',
	r: '\r',
	t: '\t',
	v: '\v',
	'"': '"',
	'\\': '\\',
	// Compose turns `\$` into `$$`, which its interpolation then reads as a
	// literal `$`. Nothing is interpolated here, so go straight to `$`.
	$: '$',
};

function expandDoubleQuoteEscapes(value: string): string {
	return value.replace(DOUBLE_QUOTE_ESCAPE, (match) => {
		const c = match[1]!;
		if (c !== '0') return SIMPLE_ESCAPES[c] ?? match;
		// Compose rewrites `\0NNN` to `\NNN` and unquotes that as a Go octal
		// escape, which needs exactly three octal digits up to 377. Anything
		// else keeps the rewritten text: `\012` reads as `\12`, a bare `\0` as `\`.
		const digits = match.slice(2);
		if (/^[0-7]{3}$/.test(digits) && Number.parseInt(digits, 8) <= 0o377) {
			return String.fromCharCode(Number.parseInt(digits, 8));
		}
		return `\\${digits}`;
	});
}

/**
 * Parse `.env` text the way docker compose does (compose-go's dotenv parser),
 * so a value read here is the value compose passes to the containers:
 *
 * - A line starting with `#` is a comment; blank lines are skipped; CRLF line
 *   endings are accepted.
 * - An optional `export ` prefix is dropped, and `KEY: value` works like
 *   `KEY=value`.
 * - An unquoted value runs to the end of its line. ` #` (a space, then `#`)
 *   starts an inline comment; a `#` with no space before it is part of the
 *   value. Surrounding whitespace is trimmed.
 * - A single-quoted value is literal, except that `\'` is a quote.
 * - A double-quoted value expands `\n`, `\r`, `\t`, `\"`, `\\`, `\$` and the
 *   other escapes compose knows; any other backslash stays as written.
 * - A quoted value may span lines. Text after the closing quote is ignored.
 *
 * Two deliberate differences, both where compose does something this reader
 * cannot reproduce:
 *
 * - Variable references (`$VAR`, `${VAR}`, `$$`) are returned as written.
 *   Compose resolves them against the shell environment it was started from,
 *   which is not available here. {@link writeEnvFile} escapes every `$`, so a
 *   value it wrote is never interpolated.
 * - Compose refuses to start on a malformed file (an unterminated quote, a
 *   space inside a key). This reader keeps going: an unterminated quoted value
 *   is taken literally up to the end of its line, and a line whose key is
 *   invalid is skipped.
 */
function parseEnvContent(raw: string): EnvMap {
	const src = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	const map: EnvMap = {};
	const lineEnd = (from: number): number => {
		const nl = src.indexOf('\n', from);
		return nl === -1 ? src.length : nl;
	};

	let i = 0;
	while (i < src.length) {
		// Statement start: skip whitespace, blank lines and comment lines.
		const c = src[i]!;
		if (c === '\n' || INLINE_SPACE.has(c)) {
			i++;
			continue;
		}
		if (c === '#') {
			i = lineEnd(i);
			continue;
		}

		// Key, up to `=` or `:`.
		const exportPrefix = /^export[ \t]+/.exec(src.slice(i, i + 16));
		if (exportPrefix) i += exportPrefix[0].length;
		let j = i;
		let validKey = true;
		while (j < src.length && src[j] !== '=' && src[j] !== ':' && src[j] !== '\n') {
			const k = src[j]!;
			if (!INLINE_SPACE.has(k) && !KEY_PUNCTUATION.has(k) && !/[\p{L}\p{N}]/u.test(k)) {
				validKey = false;
			}
			j++;
		}
		const key = src.slice(i, j).trimEnd();
		if (j >= src.length || src[j] === '\n' || !validKey || key === '' || /\s/.test(key)) {
			// No separator (compose would inherit the name from its own
			// environment, which does not exist here) or not a valid key.
			i = lineEnd(j);
			continue;
		}

		// Value.
		i = j + 1;
		while (i < src.length && INLINE_SPACE.has(src[i]!)) i++;
		const quote = src[i];
		if (quote === '"' || quote === "'") {
			let value = '';
			let escaped = false;
			let close = -1;
			for (let q = i + 1; q < src.length; q++) {
				const ch = src[q]!;
				if (ch === quote && !escaped) {
					close = q;
					break;
				}
				if (ch === quote) {
					// `\"` / `\'`: the quote itself, without the backslash.
					escaped = false;
					value += ch;
					continue;
				}
				if (ch === '\\' && !escaped) {
					escaped = true;
					continue;
				}
				if (escaped) {
					escaped = false;
					value += '\\';
				}
				value += ch;
			}
			if (close === -1) {
				const end = lineEnd(i);
				map[key] = src.slice(i, end).trimEnd();
				i = end;
				continue;
			}
			map[key] = quote === '"' ? expandDoubleQuoteEscapes(value) : value;
			i = lineEnd(close + 1);
			continue;
		}

		const end = lineEnd(i);
		let value = src.slice(i, end);
		const comment = value.indexOf(' #');
		if (comment !== -1) value = value.slice(0, comment);
		map[key] = value.trimEnd();
		i = end;
	}
	return map;
}

/**
 * Serialize one value for a `.env` line. A plain value is written bare. One
 * containing whitespace, `#`, `=`, a quote, a backtick, `$` or a backslash is
 * double-quoted with `\`, `"` and `$` escaped: compose (and
 * {@link parseEnvContent}) expands those three escapes back, and an escaped `$`
 * is never interpolated. Newlines, carriage returns and NUL are rejected by
 * {@link writeEnvFile} before this runs.
 */
function formatEnvValue(value: string): string {
	if (!/[\s#="'`$\\]/.test(value)) return value;
	return `"${value.replace(/[\\"$]/g, (ch) => `\\${ch}`)}"`;
}

export async function writeEnvFile(path: string, map: EnvMap): Promise<void> {
	const lines: string[] = [
		'# Generated by Owlat setup. Re-run setup to update.',
		`# Last updated: ${new Date().toISOString()}`,
		'',
	];
	for (const [key, value] of Object.entries(map)) {
		// Fail closed on control characters. The writer emits one physical line per
		// key, so a newline / carriage-return in a value would be reconstructed by the
		// next read as a SEPARATE, attacker-controlled env line (e.g. an injected
		// INSTANCE_SECRET). A NUL is equally illegitimate in a `.env`. Reject rather
		// than silently mangle.
		if (/[\r\n\0]/.test(value)) {
			throw new Error(
				`Refusing to write env key ${key}: value contains a newline, carriage return, or NUL.`
			);
		}
		lines.push(`${key}=${formatEnvValue(value)}`);
	}
	await writeFile(path, lines.join('\n') + '\n', { mode: 0o600 });
}

/**
 * Merge new values into an existing env map, preserving prior keys not in the
 * patch. Use this to incrementally apply wizard answers without clobbering the
 * operator's manual edits.
 */
export function mergeEnv(existing: EnvMap, patch: EnvMap): EnvMap {
	return { ...existing, ...patch };
}
