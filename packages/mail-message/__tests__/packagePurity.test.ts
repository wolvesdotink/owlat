/**
 * Locked decision D1: `@owlat/mail-message` stays pure and Convex-`'use node'`
 * safe — zero runtime dependencies beyond `node:crypto`. This test statically
 * proves it by scanning every `src/**` module and asserting that each import
 * specifier is either a relative path or exactly `node:crypto`. Any bare npm
 * import (nodemailer/mailparser survive only as devDependencies for tests) or an
 * extra `node:` builtin would fail here — and would smear the boundary that lets
 * the composer be imported straight from a Convex node action.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...collectTsFiles(full));
		} else if (entry.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

/** Every module specifier from a static `import ... from '...'` / re-export. */
function importSpecifiers(source: string): string[] {
	const specs: string[] = [];
	const re = /(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		specs.push(m[1]!);
	}
	return specs;
}

const ALLOWED_NODE_BUILTINS = new Set(['node:crypto']);

describe('@owlat/mail-message package purity (D1)', () => {
	const files = collectTsFiles(srcDir);

	it('finds the package source modules', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('imports nothing beyond relative modules and node:crypto', () => {
		const offenders: Array<{ file: string; spec: string }> = [];
		for (const file of files) {
			for (const spec of importSpecifiers(readFileSync(file, 'utf-8'))) {
				const isRelative = spec.startsWith('./') || spec.startsWith('../');
				if (isRelative) continue;
				if (ALLOWED_NODE_BUILTINS.has(spec)) continue;
				offenders.push({ file, spec });
			}
		}
		expect(offenders).toEqual([]);
	});
});
