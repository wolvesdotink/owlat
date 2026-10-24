/**
 * Guard: every Convex function reference the mail-sync worker uses must resolve to a
 * live export of the right kind in the right module.
 *
 * The `fn` table in src/convex.ts is built from the wire contract
 * (`@owlat/worker-protocol/mailSync`), whose argument and result validators apps/api
 * registers on the functions themselves. What no type can check is that a
 * contract's `path` and `kind` still name a live function: a drifted path fails
 * every call at runtime with "function not found", undetected by suites that
 * mock the Convex client. This test reads the actual apps/api Convex source
 * and asserts each ref names a real exported function whose builder matches
 * the contract's kind.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getFunctionName } from 'convex/server';
import { MAIL_SYNC_ENDPOINTS } from '@owlat/worker-protocol/mailSync';
import { fn } from '../convex.js';

type Kind = 'query' | 'mutation' | 'action';

const here = dirname(fileURLToPath(import.meta.url));
// apps/mail-sync/src/__tests__ → apps/api/convex
const apiConvexDir = resolve(here, '../../../api/convex');

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

describe('mail-sync → Convex function references', () => {
	it('the fn table is the whole contract, one function per name', () => {
		expect(Object.keys(fn).sort()).toEqual(Object.keys(MAIL_SYNC_ENDPOINTS).sort());
		const paths = Object.values(MAIL_SYNC_ENDPOINTS).map((endpoint) => endpoint.path);
		expect(new Set(paths).size).toBe(paths.length);
		for (const [key, ref] of Object.entries(fn)) {
			expect(getFunctionName(ref)).toBe(
				MAIL_SYNC_ENDPOINTS[key as keyof typeof MAIL_SYNC_ENDPOINTS].path
			);
		}
	});

	it('every fn ref points at a live export of the declared kind in the right module', () => {
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
			const kind = MAIL_SYNC_ENDPOINTS[key as keyof typeof MAIL_SYNC_ENDPOINTS].kind;
			expect(
				exported.get(fnName!),
				`${key}: '${path}' is declared as a ${kind}, but apps/api builds it differently`
			).toBe(kind);
		}
	});
});
