/**
 * The entry-bundle budget's own gate.
 *
 * Each case builds a miniature `.output` (a Nitro renderer naming the entry and
 * a `public/_nuxt` directory of chunks) and runs the real script against it.
 * Random base64 barely compresses, so a chunk of it weighs about three quarters
 * of its size in gzip and lands reliably on one side of the 242 KB budget.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-bundle-budget.ts');

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** About `kb` KB of gzip once compressed. */
function incompressible(kb: number): string {
	return `export const blob = "${randomBytes(Math.ceil(kb * 1024)).toString('base64')}";\n`;
}

function build(chunks: Record<string, string>, entry = 'entry.js'): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-bundle-budget-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'server/chunks/routes'), { recursive: true });
	writeFileSync(
		join(root, 'server/chunks/routes/renderer.mjs'),
		`const entryFileName = "${entry}";\nexport { entryFileName };\n`
	);
	mkdirSync(join(root, 'public/_nuxt'), { recursive: true });
	for (const [file, source] of Object.entries(chunks)) {
		writeFileSync(join(root, 'public/_nuxt', file), source);
	}
	return root;
}

function run(outputDir: string) {
	const result = spawnSync('bun', [SCRIPT, outputDir], { encoding: 'utf8' });
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

describe('the entry-bundle budget', () => {
	it('passes a small entry', () => {
		const result = run(build({ 'entry.js': 'console.log("boot");\n' }));

		expect(result.output).toContain('Within the 242 KB gzip budget');
		expect(result.status).toBe(0);
	});

	it('fails when a static import pushes the closure over the budget', () => {
		const result = run(
			build({
				'entry.js': 'import { blob } from "./big.js";\nconsole.log(blob);\n',
				'big.js': incompressible(260),
			})
		);

		expect(result.output).toContain('over the 242 KB budget');
		expect(result.output).toContain('big.js');
		expect(result.status).toBe(1);
	});

	it('follows bare side-effect imports and chains of imports', () => {
		const result = run(
			build({
				'entry.js': 'import "./a.js";\n',
				'a.js': 'import{x}from"./b.js";x();\n',
				'b.js': incompressible(260),
			})
		);

		expect(result.output).toContain('entry.js: 3 files,');
		expect(result.status).toBe(1);
	});

	it('leaves dynamic imports out of the closure', () => {
		const result = run(
			build({
				'entry.js': 'const load = () => import("./big.js");\nload();\n',
				'big.js': incompressible(260),
			})
		);

		expect(result.output).toContain('entry.js: 1 file,');
		expect(result.status).toBe(0);
	});

	it('refuses an output without a server renderer', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-bundle-budget-'));
		sandboxes.push(root);
		mkdirSync(join(root, 'public/_nuxt'), { recursive: true });

		const result = run(root);

		expect(result.output).toContain('no server build');
		expect(result.status).toBe(2);
	});
});
