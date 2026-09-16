import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for the one gap `plugins/0.csrf-fetch.client.ts` cannot close.
 *
 * The plugin decorates the global `$fetch`, so every caller that goes through
 * it gets nuxt-csurf's `csrf-token` header and survives the middleware. A raw
 * `fetch()` to a same-origin path does NOT, and a state-changing one is
 * answered with a bare 403 that reads like an authorization failure — the
 * shape of the bug that took out "Apply & restart", the in-app updater and the
 * setup wizard's apply at once.
 *
 * So: no client code calls `fetch()` on a relative path. Cross-origin calls
 * (Convex storage, DoH, another instance's `/api/instance-info`) are absolute
 * and must NOT carry the token, so they are none of this rule's business.
 */

const APP_DIR = join(import.meta.dirname, '..');

/**
 * Deliberate exceptions, each a read that the CSRF middleware never inspects.
 * Adding a row is a decision to make: if the call changes state, it belongs on
 * `$fetch` instead.
 */
const ALLOWED = new Map<string, string>([
	[
		'pages/desktop/connect.vue',
		'GET on the csurf-exempt /api/auth proxy; reads res.ok + res.json() directly',
	],
]);

const RAW_RELATIVE_FETCH = /(^|[^.\w$])fetch\(\s*['"`]\//;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === '__tests__' || entry === 'node_modules') continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (entry.endsWith('.ts') || entry.endsWith('.vue')) out.push(full);
	}
	return out;
}

describe('no raw fetch() to a same-origin path', () => {
	it('routes every state-changing request through the CSRF-decorated $fetch', () => {
		const offenders = walk(APP_DIR)
			.filter((file) =>
				readFileSync(file, 'utf8')
					.split('\n')
					.some((line) => RAW_RELATIVE_FETCH.test(line))
			)
			.map((file) => file.slice(APP_DIR.length + 1))
			.filter((relative) => !ALLOWED.has(relative));

		expect(offenders).toEqual([]);
	});

	it('keeps the allowlist honest — a row that no longer matches must go', () => {
		const stale = [...ALLOWED.keys()].filter(
			(relative) => !RAW_RELATIVE_FETCH.test(readFileSync(join(APP_DIR, relative), 'utf8'))
		);

		expect(stale).toEqual([]);
	});
});
