import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The invariant behind `~/lib/csrfFetch`: every state-changing request the app
 * makes goes through `apiFetch`, which carries nuxt-csurf's token.
 *
 * A POST that skips it is answered with a bare 403 by the middleware, before
 * the route handler runs — the shape of the bug that took out "Apply &
 * restart", the in-app updater and the setup wizard's apply at once. Nothing
 * about that failure looks like a missing header: it reads as an authorization
 * error, from an endpoint the operator can see they have rights to.
 *
 * So this scans client source for `fetch(` / `$fetch(` / `$fetch.raw(` calls
 * carrying a guarded method, and fails on any that is not `apiFetch` and not
 * listed below. That catches the cases a URL-shaped rule would miss — a call
 * whose URL is a variable, or one the formatter split across lines.
 */

const APP_DIR = join(import.meta.dirname, '..');

/**
 * State-changing requests that legitimately bypass `apiFetch`, each with the
 * reason. Every one is cross-origin, which is where the token must NOT go:
 * the CSRF middleware only guards this origin, and a token on a third-party
 * request is a leak. Adding a row is a decision to make — if the request goes
 * to this origin, it belongs on `apiFetch`.
 */
const ALLOWED = new Map<string, string>([
	['composables/postbox/usePostboxComposeAttachments.ts', 'upload to a minted Convex storage URL'],
	['composables/useEmailEditorBridge.ts', 'upload to a minted Convex storage URL'],
	['utils/storageUpload.ts', 'upload to a minted Convex storage URL'],
	['pages/preferences.vue', 'token-authed POST to the Convex site URL (/prefs/update)'],
	['pages/unsubscribe.vue', 'token-authed POST to the Convex site URL (/unsub)'],
	['composables/useTransactionalList.ts', 'a code sample rendered for the reader, not a request'],
]);

/** `fetch(`, `$fetch(`, `$fetch.raw(` — but not `apiFetch(` or `refetch(`. */
const CALL = /(?<![\w$.])(?:\$fetch(?:\.raw)?|fetch)\s*(?:<[^(]*?>)?\s*\(/g;
const GUARDED_METHOD = /method:\s*['"`](POST|PUT|PATCH)/i;

/**
 * The call's own argument list, so a guarded method in the NEXT call along
 * cannot be read as this one's. Quote-aware, because a URL or a body string
 * may carry an unbalanced parenthesis.
 */
function argumentsOf(source: string, openParen: number): string {
	let depth = 0;
	let quote = '';
	for (let i = openParen; i < source.length; i += 1) {
		const char = source[i]!;
		if (quote) {
			if (char === '\\') i += 1;
			else if (char === quote) quote = '';
			continue;
		}
		if (char === "'" || char === '"' || char === '`') quote = char;
		else if (char === '(') depth += 1;
		else if (char === ')') {
			depth -= 1;
			if (depth === 0) return source.slice(openParen, i + 1);
		}
	}
	return source.slice(openParen);
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === '__tests__' || entry === 'node_modules') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith('.ts') || entry.endsWith('.vue')) out.push(full);
	}
	return out;
}

/** Files with at least one guarded-method call that is not `apiFetch`. */
function bypassingFiles(): string[] {
	return walk(APP_DIR)
		.filter((file) => {
			const source = readFileSync(file, 'utf8');
			return [...source.matchAll(CALL)].some((match) =>
				GUARDED_METHOD.test(argumentsOf(source, match.index + match[0].length - 1))
			);
		})
		.map((file) => file.slice(APP_DIR.length + 1));
}

describe('every state-changing request carries the CSRF token', () => {
	it('routes POST/PUT/PATCH through apiFetch', () => {
		expect(bypassingFiles().filter((file) => !ALLOWED.has(file))).toEqual([]);
	});

	it('keeps the allowlist honest — a row that no longer bypasses must go', () => {
		const files = new Set(bypassingFiles());
		expect([...ALLOWED.keys()].filter((file) => !files.has(file))).toEqual([]);
	});
});
