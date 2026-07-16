/**
 * Unification decision U4 — the shared DKIM canonicalizer is exposed as a PURE
 * `@owlat/mail-auth/canon` subpath the outbound signer (`@owlat/mail-message`'s
 * `compose/dkim.ts`) consumes. `@owlat/mail-message` is Convex-`'use node'` safe
 * and imports nothing that touches dns/Redis/undici, so the canon subpath it
 * pulls in must be equally clean: importing `@owlat/mail-auth/canon` must NOT
 * transitively drag in the package root's SPF/DMARC/DNS/Redis machinery.
 *
 * This guard proves it statically. It (1) confirms the package.json `exports`
 * map publishes a `./canon` subpath that resolves to `src/canon.ts`, then (2)
 * walks the transitive import closure of that entry — following only relative
 * imports — and asserts every module specifier reachable from it is either a
 * relative path or one of a tiny pure allowlist (`node:crypto`, `node:buffer`).
 * Any `node:dns` / `dns` / `net` / `tls` / `ioredis` / `undici` / bare-npm
 * import anywhere in the closure fails here — that is the executable form of
 * the "the canon subpath imports no network module" merge gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../..', import.meta.url));
const packageJsonPath = resolve(packageDir, 'package.json');

/**
 * Non-relative specifiers the pure subpath is allowed to reach. Kept
 * deliberately tiny: canonicalization is byte arithmetic over Buffers, so only
 * the crypto/buffer builtins are ever legitimate. NO dns/net/tls/redis/undici.
 */
const ALLOWED_PURE_SPECIFIERS = new Set(['node:crypto', 'node:buffer']);

/** Every module specifier a source file can pull in at build- or run-time. */
function importSpecifiers(source: string): string[] {
	const specs: string[] = [];
	const patterns = [
		/(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
		/\bimport\s*['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(source)) !== null) {
			specs.push(m[1]!);
		}
	}
	return specs;
}

/** Resolve a relative specifier (possibly extensionless or `.js`) to a `.ts` file. */
function resolveRelative(fromFile: string, spec: string): string {
	const base = resolve(dirname(fromFile), spec);
	const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, resolve(base, 'index.ts')];
	for (const candidate of candidates) {
		try {
			readFileSync(candidate, 'utf-8');
			return candidate;
		} catch {
			// try next
		}
	}
	throw new Error(`Cannot resolve ${spec} from ${fromFile}`);
}

describe('@owlat/mail-auth/canon subpath purity (U4)', () => {
	it('publishes a ./canon export that resolves to src/canon.ts', () => {
		const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
			exports?: Record<string, { types?: string; import?: string }>;
		};
		const canonExport = pkg.exports?.['./canon'];
		expect(canonExport).toBeDefined();
		expect(canonExport?.import).toBe('./src/canon.ts');
		expect(canonExport?.types).toBe('./src/canon.ts');
	});

	it('imports no dns/net/tls/redis/undici module transitively — only relative paths and crypto/buffer', () => {
		const entry = resolve(packageDir, 'src/canon.ts');
		const seen = new Set<string>();
		const queue = [entry];
		const offenders: Array<{ file: string; spec: string }> = [];

		while (queue.length > 0) {
			const file = queue.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);

			for (const spec of importSpecifiers(readFileSync(file, 'utf-8'))) {
				if (spec.startsWith('./') || spec.startsWith('../')) {
					queue.push(resolveRelative(file, spec));
					continue;
				}
				if (ALLOWED_PURE_SPECIFIERS.has(spec)) continue;
				offenders.push({ file, spec });
			}
		}

		// canon.ts today imports nothing at all, so the closure is a single file
		// and this asserts an empty offender list — but the transitive walk keeps
		// the guard honest if a future edit adds a relative helper.
		expect(offenders).toEqual([]);
		expect(seen.has(entry)).toBe(true);
	});
});
