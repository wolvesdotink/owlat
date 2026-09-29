/**
 * Guard: every Convex function reference the IMAP server uses must resolve to a
 * live export of the right kind in the right module.
 *
 * The `fn` table in src/convex.ts declares its references with
 * `makeFunctionReference`, typed by hand because this workspace does not import
 * apps/api's generated API. Typecheck therefore catches a wrong argument at a
 * call site, but not a path or kind that has drifted from apps/api, and the
 * connection tests mock the Convex client. A prior regression pointed these at
 * the pre-refactor flat module names (`mailImap:` / `mailAppPasswords:`) that no
 * longer exist, which broke every IMAP command (including LOGIN) at runtime
 * with "function not found", undetected by the rest of the suite. This test
 * reads the actual apps/api Convex source and asserts each ref names a real
 * exported function whose builder matches the declared kind.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getFunctionName } from 'convex/server';
import { fn } from '../convex.js';

type Kind = 'query' | 'mutation' | 'action';

const here = dirname(fileURLToPath(import.meta.url));
// apps/imap/src/__tests__ → apps/api/convex
const apiConvexDir = resolve(here, '../../../api/convex');

/** The kind each path is declared with in src/convex.ts. */
function declaredKinds(): Map<string, Kind> {
	const src = readFileSync(resolve(here, '../convex.ts'), 'utf8');
	const kinds = new Map<string, Kind>();
	const declaration =
		/makeFunctionReference<\s*'(query|mutation|action)'[\s\S]*?>\(\s*'([^']+)'\s*\)/g;
	for (const m of src.matchAll(declaration)) kinds.set(m[2]!, m[1] as Kind);
	return kinds;
}

/** Each exported function of a Convex module, with the kind of its builder. */
function exportsOf(modulePath: string): Map<string, Kind | null> {
	let src: string;
	try {
		src = readFileSync(resolve(apiConvexDir, `${modulePath}.ts`), 'utf8');
	} catch {
		throw new Error(`Convex module not found: ${modulePath}.ts (resolved under ${apiConvexDir})`);
	}
	const names = new Map<string, Kind | null>();
	for (const m of src.matchAll(/export const (\w+)\s*=\s*(\w+)\(/g)) {
		const builder = m[2]!.toLowerCase();
		const kind = (['query', 'mutation', 'action'] as const).find((k) => builder.endsWith(k));
		names.set(m[1]!, kind ?? null);
	}
	return names;
}

describe('IMAP → Convex function references', () => {
	it('every fn ref points at a live export of the declared kind in the right module', () => {
		const kinds = declaredKinds();
		const cache = new Map<string, Map<string, Kind | null>>();
		for (const [key, ref] of Object.entries(fn)) {
			const path = getFunctionName(ref);
			expect(path, `${key} must be a "module:function" ref`).toMatch(/^[\w/]+:\w+$/);
			const [modulePath, fnName] = path.split(':');
			if (!cache.has(modulePath!)) cache.set(modulePath!, exportsOf(modulePath!));
			const exported = cache.get(modulePath!)!;
			expect(
				exported.has(fnName!),
				`${key}: '${path}' — ${modulePath}.ts does not export '${fnName}'`
			).toBe(true);
			expect(
				kinds.get(path),
				`${key}: '${path}' has no declared kind in src/convex.ts`
			).toBeDefined();
			expect(
				exported.get(fnName!),
				`${key}: '${path}' is declared as a ${kinds.get(path)}, but apps/api builds it differently`
			).toBe(kinds.get(path));
		}
	});
});
