/**
 * Guard: every Convex function reference the IMAP server uses must resolve to a
 * live export in the right module.
 *
 * The `fn` table in src/convex.ts holds `module/path:function` strings cast
 * `as never`, so typecheck cannot validate them and the connection tests mock
 * the Convex client. A prior regression pointed these at the pre-refactor flat
 * module names (`mailImap:` / `mailAppPasswords:`) that no longer exist, which
 * broke every IMAP command (including LOGIN) at runtime with "function not
 * found" — undetected by the rest of the suite. This test reads the actual
 * apps/api Convex source and asserts each ref names a real exported function.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fn } from '../convex.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/imap/src/__tests__ → apps/api/convex
const apiConvexDir = resolve(here, '../../../api/convex');

function exportsOf(modulePath: string): Set<string> {
	let src: string;
	try {
		src = readFileSync(resolve(apiConvexDir, `${modulePath}.ts`), 'utf8');
	} catch {
		throw new Error(
			`Convex module not found: ${modulePath}.ts (resolved under ${apiConvexDir})`,
		);
	}
	const names = new Set<string>();
	for (const m of src.matchAll(/export const (\w+)\s*=/g)) names.add(m[1]!);
	return names;
}

describe('IMAP → Convex function references', () => {
	it('every fn ref points at a live export in the right module', () => {
		const cache = new Map<string, Set<string>>();
		for (const [key, ref] of Object.entries(fn)) {
			expect(ref, `${key} must be a "module:function" ref`).toMatch(/^[\w/]+:\w+$/);
			const [modulePath, fnName] = ref.split(':');
			if (!cache.has(modulePath!)) cache.set(modulePath!, exportsOf(modulePath!));
			expect(
				cache.get(modulePath!)!.has(fnName!),
				`${key}: '${ref}' — ${modulePath}.ts does not export '${fnName}'`,
			).toBe(true);
		}
	});
});
