/**
 * Locked decision D1 / U4 / W1: `@owlat/mail-message` stays pure and
 * Convex-`'use node'` safe — the ONLY runtime imports it may pull are
 * `node:crypto` and the dependency-free `@owlat/mail-canon` leaf (the single
 * shared DKIM canonicalizer the outbound signer consumes; that leaf transitively
 * imports no dns/Redis/node-only module — proven by mail-auth's own
 * `canonSubpathPurity` guard, which walks the same bytes through the `./canon`
 * re-export). This test statically proves it by scanning every `src/**` module
 * and asserting that each import specifier is either a relative path,
 * `node:crypto`, or `@owlat/mail-canon`. Any bare npm import
 * (nodemailer/mailparser/mailauth survive only as devDependencies for tests),
 * the `@owlat/mail-auth` package ROOT (which does import dns/Redis — and would
 * close a build cycle), or an extra `node:` builtin would fail here — and would
 * smear the boundary that lets the composer be imported straight from a Convex
 * node action.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			// Co-located test dirs (the parse side keeps its suites under
			// `src/**/__tests__/`) are not shipped runtime modules — they
			// legitimately import `vitest` and are excluded from coverage. The
			// purity gate only governs production source, so skip them here.
			if (entry === '__tests__') continue;
			out.push(...collectTsFiles(full));
		} else if (entry.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Every module specifier a module can pull in at build- or run-time:
 *   - `import … from '…'` / `export … from '…'` (static named/default/namespace)
 *   - `import '…'` (bare side-effect import — no `from`)
 *   - `import('…')` (dynamic import)
 *   - `require('…')` (CJS interop)
 * A purity gate that only scanned the first form would let `import 'nodemailer';`
 * or `require('nodemailer')` smuggle a runtime dependency past D1 undetected.
 */
function importSpecifiers(source: string): string[] {
	const specs: string[] = [];
	const patterns = [
		// import ... from '...' / export ... from '...'
		/(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
		// bare side-effect import: import '...'
		/\bimport\s*['"]([^'"]+)['"]/g,
		// dynamic import('...')
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		// require('...')
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

// The only non-relative specifiers `src/**` may import at runtime: the crypto
// builtin and the dependency-free shared canonicalizer leaf `@owlat/mail-canon`
// (U4). The `@owlat/mail-auth` package ROOT is deliberately NOT allowed — it
// imports dns/Redis (and depending on it would also close a build cycle
// mail-message → mail-auth → shared → mail-message).
const ALLOWED_SPECIFIERS = new Set(['node:crypto', '@owlat/mail-canon']);

describe('@owlat/mail-message package purity (D1)', () => {
	const files = collectTsFiles(srcDir);

	it('finds the package source modules', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing beyond relative modules, node:crypto and the shared canon subpath', () => {
		const offenders: Array<{ file: string; spec: string }> = [];
		for (const file of files) {
			for (const spec of importSpecifiers(readFileSync(file, 'utf-8'))) {
				const isRelative = spec.startsWith('./') || spec.startsWith('../');
				if (isRelative) continue;
				if (ALLOWED_SPECIFIERS.has(spec)) continue;
				offenders.push({ file, spec });
			}
		}
		expect(offenders).toEqual([]);
	});

	it('declares exactly the pure shared-canon leaf as its only runtime dependency (U4/W1)', () => {
		const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
			dependencies?: Record<string, string>;
		};
		// The one sanctioned runtime dependency: the dependency-free shared
		// canonicalizer leaf `@owlat/mail-canon`. nodemailer / mailparser / mailauth
		// (and `@owlat/mail-auth` itself, used only by the three-way verify test)
		// survive solely as devDependencies for the differential/oracle tests, so
		// they must NOT appear here.
		expect(pkg.dependencies).toEqual({ '@owlat/mail-canon': 'workspace:*' });
	});
});
