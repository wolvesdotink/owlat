/**
 * The test-code-in-the-build gate's own tests.
 *
 * Each case builds a miniature `.output` (the traced server `package.json`, the
 * client manifest and a `public/_nuxt` directory of chunks) and runs the real
 * script against it. The leaking inputs are the shapes #1172 found in a real
 * build of apps/web.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '../check-web-build-test-code.ts');

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

const CLEAN_MANIFEST = 'const manifest = {"pages/index.vue":{file:"a.js",isDynamicEntry:true}};\n';
const CLEAN_ROUTES =
	'const routes=[{name:`dashboard`,path:`/dashboard`,component:()=>import("./b.js")}];\n';

function build({
	dependencies = { vue: '3.5.40', h3: '1.15.11' },
	manifest = CLEAN_MANIFEST,
	chunks = { 'entry.js': CLEAN_ROUTES },
}: {
	dependencies?: Record<string, string>;
	manifest?: string;
	chunks?: Record<string, string>;
} = {}): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-build-test-code-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'server/chunks/virtual'), { recursive: true });
	writeFileSync(
		join(root, 'server/package.json'),
		JSON.stringify({ name: '@owlat/web-prod', dependencies })
	);
	writeFileSync(join(root, 'server/chunks/virtual/precomputed.mjs'), manifest);
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

describe('the test-code-in-the-build gate', () => {
	it('passes a build without test code', () => {
		const result = run(build());

		expect(result.output).toContain('No test packages');
		expect(result.status).toBe(0);
	});

	it('fails when Nitro traced vitest into the server bundle', () => {
		const result = run(
			build({
				dependencies: {
					vue: '3.5.40',
					vitest: '4.1.11',
					'@vitest/expect': '4.1.11',
					chai: '6.2.2',
				},
			})
		);

		expect(result.output).toContain('server/package.json depends on vitest');
		expect(result.output).toContain('server/package.json depends on @vitest/expect');
		expect(result.output).toContain('server/package.json depends on chai');
		expect(result.status).toBe(1);
	});

	it('fails when a __tests__ helper became a route', () => {
		const result = run(
			build({
				chunks: {
					'entry.js':
						CLEAN_ROUTES +
						'const more=[{name:`dashboard-automations-__tests__-editPageHarness`,path:`/dashboard/automations/__tests__/editPageHarness`}];\n',
				},
			})
		);

		expect(result.output).toContain('public/_nuxt/entry.js');
		expect(result.output).toContain('/dashboard/automations/__tests__/editPageHarness');
		expect(result.status).toBe(1);
	});

	it('fails when the client manifest names a test module or a vitest package', () => {
		const result = run(
			build({
				manifest:
					'const m = {"pages/dashboard/automations/__tests__/editPageHarness.ts":{file:"c.js"},' +
					'"../../../node_modules/@vitest/snapshot/node_modules/magic-string/dist/magic-string.es.mjs":{file:"d.js"}};\n',
			})
		);

		expect(result.output).toContain('precomputed.mjs');
		expect(result.output).toContain('editPageHarness.ts');
		expect(result.output).toContain('@vitest/snapshot');
		expect(result.status).toBe(1);
	});

	it('fails when a client chunk bundles vitest', () => {
		const result = run(
			build({
				chunks: {
					'entry.js': CLEAN_ROUTES,
					'harness.js': 'const jo=[`node:internal`,`/vitest/dist/`,`/node_modules/`];\n',
				},
			})
		);

		expect(result.output).toContain('public/_nuxt/harness.js');
		expect(result.status).toBe(1);
	});

	it('refuses an output without a server build', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-build-test-code-'));
		sandboxes.push(root);
		mkdirSync(join(root, 'public/_nuxt'), { recursive: true });

		const result = run(root);

		expect(result.output).toContain('no server build');
		expect(result.status).toBe(2);
	});
});
