/**
 * The helpers the bun wiring checks in `apps/api/scripts/` share
 * (`apps/api/scripts/lib/sourceGraph.ts`). Each check used to carry its own
 * walker, comment stripper and import resolver, and they had drifted apart;
 * these cases pin the one policy each now follows.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
	boundNames,
	createChecker,
	productionModules,
	resolveRelative,
	sourceMap,
	stripComments,
	valueExports,
} from '../../apps/api/scripts/lib/sourceGraph';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway tree holding `files` (empty contents unless given). */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-source-graph-'));
	roots.push(root);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
	return root;
}

describe('productionModules', () => {
	const root = tree({
		'crons.ts': '',
		'delivery/ramp.ts': '',
		'delivery/ramp.test.ts': '',
		'delivery/ramp.spec.ts': '',
		'delivery/__tests__/ramp.integration.ts': '',
		'_generated/api.d.ts': '',
		'betterAuth/_generated/server.ts': '',
		'node_modules/pkg/index.ts': '',
		'dist/index.d.ts': '',
		'.nuxt/types.ts': '',
		'.output/server/index.ts': '',
		'build/out.ts': '',
		'coverage/report.ts': '',
		'server/routes/.well-known/security.txt.ts': '',
		'app/pages/index.vue': '',
		'README.md': '',
	});
	const walked = (extensions?: readonly string[]): string[] =>
		productionModules(root, extensions === undefined ? {} : { extensions }).map((file) =>
			relative(root, file)
		);

	it('walks production .ts files only, sorted, skipping every non-production directory', () => {
		expect(walked()).toEqual([
			'crons.ts',
			'delivery/ramp.ts',
			'server/routes/.well-known/security.txt.ts',
		]);
	});

	it('takes more extensions on request', () => {
		expect(walked(['.ts', '.vue'])).toContain('app/pages/index.vue');
	});

	it('returns nothing for a missing root', () => {
		expect(productionModules(join(root, 'missing'))).toEqual([]);
	});

	it('keys each stripped source by its relative path', () => {
		const sources = sourceMap(root, productionModules(root));
		expect([...sources.keys()]).toEqual(walked());
	});
});

describe('stripComments', () => {
	it('strips a trailing line comment that names an emitter', () => {
		const source = "const x = 1; // transportOutcomeEffect(ref, 'delivered', at)\n";
		expect(stripComments(source)).not.toContain('transportOutcomeEffect');
		expect(stripComments(source)).toContain('const x = 1;');
	});

	it('strips whole-line and block comments', () => {
		const source = '// internal.a.b\n/* api.c.d\n */\nconst y = 2;\n';
		expect(stripComments(source).trim()).toBe('const y = 2;');
	});

	it("keeps a URL inside a string: '//' after ':' is no comment", () => {
		const source = "const url = 'https://x.example/path'; // note\n";
		expect(stripComments(source)).toBe("const url = 'https://x.example/path'; \n");
	});

	it('strips an HTML comment in a .vue template, before the // pass can eat its end', () => {
		const source = [
			'<template>',
			'\t<!-- api.mail.send.run // was here -->',
			'\t<div />',
			'</template>',
		].join('\n');
		const stripped = stripComments(source);
		expect(stripped).not.toContain('api.mail.send.run');
		expect(stripped).not.toContain('-->');
		expect(stripped).toContain('<div />');
	});
});

describe('resolveRelative', () => {
	it('returns both the file and the folder index', () => {
		expect(resolveRelative('delivery/ramp.ts', './seedDemo')).toEqual([
			'delivery/seedDemo.ts',
			'delivery/seedDemo/index.ts',
		]);
	});

	it('drops a .js extension and walks up', () => {
		expect(resolveRelative('delivery/ramp/gate.ts', '../outcome.js')).toEqual([
			'delivery/outcome.ts',
			'delivery/outcome/index.ts',
		]);
	});

	it('resolves a package specifier to nothing', () => {
		expect(resolveRelative('crons.ts', '@owlat/shared')).toEqual([]);
	});
});

describe('boundNames and valueExports', () => {
	it('keeps both sides of `as` and drops inline `type` specifiers', () => {
		expect(boundNames('{ a, b as c, type D, type E as F }')).toEqual(['a', 'b', 'c']);
	});

	it('reads a default import beside named ones', () => {
		expect(boundNames('schema, { tables }')).toEqual(['schema', 'tables']);
	});

	it('collects declared and re-listed value exports', () => {
		const source = [
			'export const one = 1;',
			'export async function two() {}',
			'export class Three {}',
			'const four = 4;',
			'export { four as five, type Six };',
			'export type Seven = string;',
		].join('\n');
		expect([...valueExports(source)].sort()).toEqual(['Three', 'five', 'four', 'one', 'two']);
	});
});

describe('createChecker', () => {
	it('collects failures and exits 1 on report', () => {
		const checker = createChecker();
		checker.check(true, 'never recorded');
		checker.check(false, 'recorded');
		checker.expectEmpty([], 'never recorded either');
		checker.expectEmpty(['a', 'b'], 'listed');
		expect(checker.failures).toEqual(['recorded', 'listed\n  a\n  b']);

		const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		checker.report('check-x', 'detail');
		expect(error).toHaveBeenCalledWith('FAIL: recorded');
		expect(exit).toHaveBeenCalledWith(1);
		exit.mockRestore();
		error.mockRestore();
	});

	it('prints the OK line when nothing failed', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		createChecker().report('check-x', '3 things');
		expect(log).toHaveBeenCalledWith('check-x: OK (3 things)');
		log.mockRestore();
	});
});
