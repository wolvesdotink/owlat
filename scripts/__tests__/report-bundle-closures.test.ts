/**
 * The route and deferred-feature closure report.
 *
 * Each case builds a miniature `.output` (a Nitro renderer naming the entry,
 * the precomputed client manifest and a `public/_nuxt` directory of chunks)
 * and runs the real script against it, with a budgets file of its own. The
 * manifest and import shapes are the
 * ones a real `nuxt build` of apps/web emits: pages and lazily imported
 * components keyed by source path, shared chunks by an `_<hash>.js` id with a
 * chunk name, and `import()` quoted with backticks.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { parseClosureBudgets, suggestedBudgetKiB } from '../bundle-closure';
import { scriptGzipSizes } from './bundleGzip.testlib';

const SCRIPT = resolve(import.meta.dirname, '../report-bundle-closures.ts');
const COMMITTED_BUDGETS = resolve(import.meta.dirname, '../bundle-closure-budgets.txt');

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

interface Resource {
	file: string;
	src?: string;
	name?: string;
}

function precomputed(resources: Record<string, Resource>): string {
	const modules: Record<string, { file: string }> = {};
	const dependencies: Record<string, { preload: Record<string, Resource> }> = {};
	for (const [id, resource] of Object.entries(resources)) {
		modules[id] = { file: resource.file };
		dependencies[id] = { preload: { [id]: resource } };
	}
	return `const client_precomputed = ${JSON.stringify({ dependencies, entrypoints: [], modules })};\nexport { client_precomputed as default };\n`;
}

function build(
	chunks: Record<string, string>,
	resources: Record<string, Resource> | null,
	entry = 'entry.js'
): string {
	const root = mkdtempSync(join(tmpdir(), 'owlat-bundle-closures-'));
	sandboxes.push(root);
	mkdirSync(join(root, 'server/chunks/routes'), { recursive: true });
	writeFileSync(
		join(root, 'server/chunks/routes/renderer.mjs'),
		`const entryFileName = "${entry}";\nexport { entryFileName };\n`
	);
	if (resources) {
		mkdirSync(join(root, 'server/chunks/virtual'), { recursive: true });
		writeFileSync(join(root, 'server/chunks/virtual/precomputed.mjs'), precomputed(resources));
	}
	mkdirSync(join(root, 'public/_nuxt'), { recursive: true });
	for (const [file, source] of Object.entries(chunks)) {
		writeFileSync(join(root, 'public/_nuxt', file), source);
	}
	return root;
}

/** Generous budgets for every closure of the CHUNKS build. */
const ROOMY = [
	'route 1024 pages/emails/[id]/edit.vue',
	'route 1024 pages/index.vue',
	'deferred 1024 components/SendTestEmailModal.vue',
].join('\n');

/** A budgets file in its own sandbox, so the committed one never applies. */
function budgetsFile(text: string, keep = sandboxes): string {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-bundle-budgets-'));
	keep.push(dir);
	const path = join(dir, 'budgets.txt');
	writeFileSync(path, `# fixture budgets\n${text}\n`);
	return path;
}

/** One ROOMY file for every default run, so two runs print the same header. */
const roomyKeep: string[] = [];
const roomyBudgets = budgetsFile(ROOMY, roomyKeep);
afterAll(() => {
	for (const dir of roomyKeep) rmSync(dir, { recursive: true, force: true });
});

function run(outputDir: string, ...flags: string[]) {
	return runWith({}, outputDir, ...flags);
}

/** Run with these provenance variables only; CI's own are never inherited. */
function runWith(env: Record<string, string>, outputDir: string, ...flags: string[]) {
	const {
		BUNDLE_REPORT_SHA: _sha,
		BUNDLE_REPORT_TOOLCHAIN: _toolchain,
		...inherited
	} = process.env;
	const budgets = flags.includes('--budgets') ? [] : ['--budgets', roomyBudgets];
	const result = spawnSync('bun', [SCRIPT, outputDir, ...flags, ...budgets], {
		encoding: 'utf8',
		env: { ...inherited, ...env },
	});
	return {
		status: result.status ?? -1,
		stdout: result.stdout,
		output: `${result.stdout}${result.stderr}`,
	};
}

interface Closure {
	key: string;
	budgetKiB: number | null;
	root: string;
	importers?: string[];
	closure: { files: number; raw: number; gzip: number };
	beyondEntry: {
		files: number;
		raw: number;
		gzip: number;
		chunks: { file: string; label: string | null; gzip: number }[];
	};
}
interface Report {
	meta: { assets: string; budget: string; sha: string | null; toolchain: string | null };
	entry: {
		key: string;
		closure: { files: number; raw: number; gzip: number };
		chunks: { key: string; gzip: number }[];
	};
	routes: Closure[];
	deferred: Closure[];
}

const report = (outputDir: string) => JSON.parse(run(outputDir, '--json').stdout) as Report;

const CHUNKS: Record<string, string> = {
	// The entry statically shares vue with every page and lazy-loads the pages.
	'entry.js':
		'import{v}from"./vue.js";const r=[()=>import(`./index.js`),()=>import(`./edit.js`)];v(r);\n',
	'vue.js': 'export const v=(x)=>x;\n',
	'index.js': 'import{v}from"./vue.js";export default v("home");\n',
	// The editor page pulls a heavy builder in statically and a modal lazily.
	'edit.js':
		'import{v}from"./vue.js";import"./builder.js";const m=()=>import(`./modal.js`);export default v(m);\n',
	'builder.js': `import{c}from"./codemirror.js";export const b=c+"${'b'.repeat(4000)}";\n`,
	'codemirror.js': `export const c="${'c'.repeat(6000)}";\n`,
	'modal.js': 'import{v}from"./vue.js";import{c}from"./codemirror.js";export default v(c);\n',
};

const RESOURCES: Record<string, Resource> = {
	'../node_modules/nuxt/dist/app/entry.js': {
		file: 'entry.js',
		src: '../node_modules/nuxt/dist/app/entry.js',
	},
	'_vue.js': { file: 'vue.js', name: 'vue' },
	'pages/index.vue': { file: 'index.js', src: 'pages/index.vue' },
	'pages/emails/[id]/edit.vue': { file: 'edit.js', src: 'pages/emails/[id]/edit.vue' },
	'_builder.js': { file: 'builder.js', name: 'src' },
	'_codemirror.js': { file: 'codemirror.js', name: 'codemirror' },
	'components/SendTestEmailModal.vue': {
		file: 'modal.js',
		src: 'components/SendTestEmailModal.vue',
	},
};

/**
 * `bytes` of seeded pseudo-random data as base64: the same on every run, and
 * gzip cannot shrink it below about three quarters of its base64 length.
 */
function incompressible(bytes: number): string {
	const buffer = Buffer.alloc(bytes);
	let state = 0x2545f491;
	for (let i = 0; i < bytes; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		buffer[i] = state & 0xff;
	}
	return buffer.toString('base64');
}

const raw = (...files: string[]) =>
	files.reduce((sum, file) => sum + (CHUNKS[file] as string).length, 0);

describe('the route and deferred-feature closure report', () => {
	it('reports each page by source path with what it adds beyond the entry closure', () => {
		const output = build(CHUNKS, RESOURCES);
		const sizes = scriptGzipSizes(join(output, 'public/_nuxt'), Object.keys(CHUNKS));
		const gz = (file: string) => sizes[file] as number;
		const result = report(output);

		expect(result.meta).toEqual({
			assets: 'javascript-only',
			budget: 'budgets.txt',
			sha: null,
			toolchain: null,
		});
		expect(result.entry).toEqual({
			key: '../node_modules/nuxt/dist/app/entry.js',
			closure: { files: 2, raw: raw('entry.js', 'vue.js'), gzip: gz('entry.js') + gz('vue.js') },
			// The entry closure's own chunks, largest first, named like the rest.
			chunks: [
				{ key: '../node_modules/nuxt/dist/app/entry.js', gzip: gz('entry.js') },
				{ key: 'vue', gzip: gz('vue.js') },
			].sort((a, b) => b.gzip - a.gzip || (a.key < b.key ? -1 : 1)),
		});
		expect(result.routes.map((route) => route.key)).toEqual([
			'pages/emails/[id]/edit.vue',
			'pages/index.vue',
		]);

		const [edit, index] = result.routes as [Closure, Closure];
		expect(edit.root).toBe('edit.js');
		expect(edit.budgetKiB).toBe(1024);
		expect(edit.closure.files).toBe(4);
		expect(edit.beyondEntry.chunks).toEqual([
			{ file: 'builder.js', label: 'src', gzip: gz('builder.js') },
			{ file: 'codemirror.js', label: 'codemirror', gzip: gz('codemirror.js') },
			{ file: 'edit.js', label: 'pages/emails/[id]/edit.vue', gzip: gz('edit.js') },
		]);
		expect(edit.beyondEntry.raw).toBe(raw('builder.js', 'codemirror.js', 'edit.js'));
		// The lazily imported modal stays out of the page's closure.
		expect(edit.beyondEntry.chunks.map((chunk) => chunk.file)).not.toContain('modal.js');

		expect(index.beyondEntry).toMatchObject({ files: 1, raw: raw('index.js') });
	});

	it('names the commit and toolchain it was taken from when CI says so', () => {
		const output = build(CHUNKS, RESOURCES);
		const result = JSON.parse(
			runWith(
				{ BUNDLE_REPORT_SHA: 'abc123', BUNDLE_REPORT_TOOLCHAIN: 'bun-1.4.2+docker-0f00' },
				output,
				'--json'
			).stdout
		) as Report;

		expect(result.meta).toMatchObject({ sha: 'abc123', toolchain: 'bun-1.4.2+docker-0f00' });
	});

	it('reports every lazily imported chunk as a deferred feature with its importers', () => {
		const result = report(build(CHUNKS, RESOURCES));

		expect(result.deferred).toHaveLength(1);
		const [modal] = result.deferred as [Closure];
		expect(modal.key).toBe('components/SendTestEmailModal.vue');
		expect(modal.importers).toEqual(['pages/emails/[id]/edit.vue']);
		expect(modal.beyondEntry.chunks.map((chunk) => chunk.file)).toEqual([
			'codemirror.js',
			'modal.js',
		]);
	});

	it('tells unnamed and same-named lazy chunks apart by importer, then by order', () => {
		const result = report(
			build(
				{
					'entry.js': 'import(`./a.js`);import(`./b.js`);import(\'./anon.js\');import("./p.js");\n',
					'p.js': 'import(`./c.js`);import(`./anon.js`);\n',
					'a.js': 'export const a=1;\n',
					'b.js': 'export const b=1;\n',
					'c.js': 'export const c=1;\n',
					'anon.js': 'export const anon=1;\n',
				},
				{
					'_entry.js': { file: 'entry.js', name: 'entry' },
					'pages/p.vue': { file: 'p.js', src: 'pages/p.vue' },
					'_a.js': { file: 'a.js', name: 'index' },
					'_b.js': { file: 'b.js', name: 'index' },
					'_c.js': { file: 'c.js', name: 'index' },
				}
			)
		);

		expect(result.deferred.map((feature) => [feature.key, feature.root])).toEqual([
			['(unnamed) <- entry, pages/p.vue', 'anon.js'],
			['index <- entry', 'a.js'],
			['index <- entry #2', 'b.js'],
			['index <- pages/p.vue', 'c.js'],
		]);
	});

	it('prints the same sorted report on every run, the entry budget aside', () => {
		const output = build(
			{
				...CHUNKS,
				'codemirror.js': `export const c="${incompressible(320 * 1024)}";\n`,
			},
			RESOURCES
		);

		// Far over the entry's 254 KiB gzip budget, which must not apply here.
		const edit = report(output).routes.find((route) => route.key === 'pages/emails/[id]/edit.vue');
		expect(edit?.beyondEntry.gzip).toBeGreaterThan(254 * 1024);

		const first = run(output);
		const second = run(output);

		expect(first.status).toBe(0);
		expect(second.stdout).toBe(first.stdout);
		expect(first.stdout).toContain(`budgets: ${roomyBudgets}`);
		expect(first.stdout).toContain('Every route and deferred feature is within its budget.');
		expect(first.stdout).toContain('Totals count JavaScript chunks only');
		const pageRows = first.stdout
			.split('\n')
			.map((line) => line.trim().split(/\s+/).at(4))
			.filter((key) => key?.startsWith('pages/'));
		expect(pageRows).toEqual(['pages/emails/[id]/edit.vue', 'pages/index.vue']);
		expect(first.stdout).toMatch(
			/components\/SendTestEmailModal\.vue {2}\[pages\/emails\/\[id\]\/edit\.vue\]/
		);
	});

	it('reads the same for two builds whose entry differs only in its hashed name', () => {
		const { 'entry.js': entrySource, ...rest } = CHUNKS;
		const rebuilt = build(
			{ ...rest, 'Xy12AbCd.js': entrySource as string },
			{
				...RESOURCES,
				'../node_modules/nuxt/dist/app/entry.js': {
					file: 'Xy12AbCd.js',
					src: '../node_modules/nuxt/dist/app/entry.js',
				},
			},
			'Xy12AbCd.js'
		);

		const original = build(CHUNKS, RESOURCES);
		expect(run(rebuilt, '--json').stdout).toBe(run(original, '--json').stdout);
		expect(run(rebuilt).stdout).toBe(run(original).stdout);
	});

	it('refuses a build without the client manifest', () => {
		const result = run(build(CHUNKS, null));

		expect(result.output).toContain('no client build manifest');
		expect(result.status).toBe(2);
	});

	it('refuses an output without a server renderer', () => {
		const root = mkdtempSync(join(tmpdir(), 'owlat-bundle-closures-'));
		sandboxes.push(root);
		mkdirSync(join(root, 'public/_nuxt'), { recursive: true });

		const result = run(root);

		expect(result.output).toContain('report-bundle-closures: no server build');
		expect(result.status).toBe(2);
	});
});

describe('the route and deferred-feature budgets', () => {
	/** The CHUNKS build with the editor page's builder well over a 4 KiB budget. */
	const heavyEditor = () =>
		build(
			{ ...CHUNKS, 'builder.js': `export const b="${incompressible(8 * 1024)}";\n` },
			RESOURCES
		);
	const budgets = (edit: number, modal = 1024) =>
		budgetsFile(
			[
				`route ${edit} pages/emails/[id]/edit.vue`,
				'route 1024 pages/index.vue',
				`deferred ${modal} components/SendTestEmailModal.vue`,
			].join('\n')
		);

	it('fails when a page closure is over its budget, and passes once it fits', () => {
		const output = heavyEditor();

		const failing = run(output, '--budgets', budgets(4));
		expect(failing.status).toBe(1);
		expect(failing.output).toContain('1 closure is over budget');
		expect(failing.output).toMatch(
			/route pages\/emails\/\[id\]\/edit\.vue: [\d.]+ KB gzip, over its 4 KB budget/
		);
		expect(failing.output).not.toContain('pages/index.vue: ');

		expect(run(output, '--budgets', budgets(64)).status).toBe(0);
	});

	it('fails when a deferred feature closure is over its budget', () => {
		const result = run(build(CHUNKS, RESOURCES), '--budgets', budgets(1024, 0));

		expect(result.status).toBe(1);
		expect(result.output).toMatch(
			/deferred components\/SendTestEmailModal\.vue: [\d.]+ KB gzip, over its 0 KB budget/
		);
	});

	it('records an over-budget build as JSON without failing', () => {
		const result = run(heavyEditor(), '--json', '--budgets', budgets(4));
		const edit = (JSON.parse(result.stdout) as Report).routes.find(
			(route) => route.key === 'pages/emails/[id]/edit.vue'
		);

		expect(result.status).toBe(0);
		expect(edit?.budgetKiB).toBe(4);
		expect(edit?.beyondEntry.gzip).toBeGreaterThan(4 * 1024);
	});

	it('fails on a closure without a budget line and prints the line to add', () => {
		const output = build(CHUNKS, RESOURCES);
		const gzip = report(output).routes.find((route) => route.key === 'pages/index.vue')?.beyondEntry
			.gzip as number;

		const result = run(
			output,
			'--budgets',
			budgetsFile(
				'route 1024 pages/emails/[id]/edit.vue\ndeferred 1024 components/SendTestEmailModal.vue'
			)
		);

		expect(result.status).toBe(1);
		expect(result.output).toContain('1 closure has no budget');
		expect(result.output).toContain(`  route ${suggestedBudgetKiB(gzip)} pages/index.vue`);
	});

	it('fails on a budget line whose closure the build no longer has', () => {
		const result = run(
			build(CHUNKS, RESOURCES),
			'--budgets',
			budgetsFile(`${ROOMY}\nroute 12 pages/removed.vue`)
		);

		expect(result.status).toBe(1);
		expect(result.output).toContain('names a closure this build does not have');
		expect(result.output).toContain('  route 12 pages/removed.vue');
	});

	it('refuses a malformed budgets file', () => {
		const result = run(
			build(CHUNKS, RESOURCES),
			'--budgets',
			budgetsFile('route big pages/index.vue')
		);

		expect(result.output).toContain('line 2 is not');
		expect(result.status).toBe(2);
	});

	it('parses budget lines, keys with spaces included, and rejects repeats', () => {
		const parsed = parseClosureBudgets(
			'# header\n\nroute 12 pages/index.vue\ndeferred 3 (unnamed) <- entry, pages/p.vue\n'
		);

		expect([...parsed.route]).toEqual([['pages/index.vue', 12]]);
		expect([...parsed.deferred]).toEqual([['(unnamed) <- entry, pages/p.vue', 3]]);
		expect(() => parseClosureBudgets('route 1 a.vue\nroute 2 a.vue')).toThrow(
			'line 2 repeats route a.vue'
		);
	});

	it('starts a budget at the size plus the larger of 10% and 2 KiB, in whole KiB', () => {
		expect(suggestedBudgetKiB(0)).toBe(2);
		expect(suggestedBudgetKiB(10 * 1024)).toBe(12);
		expect(suggestedBudgetKiB(100 * 1024)).toBe(110);
		expect(suggestedBudgetKiB(100 * 1024 + 1)).toBe(111);
	});

	it('commits a budgets file that parses and budgets both routes and deferred features', () => {
		const committed = parseClosureBudgets(readFileSync(COMMITTED_BUDGETS, 'utf8'));

		expect(committed.route.size).toBeGreaterThan(0);
		expect(committed.deferred.size).toBeGreaterThan(0);
	});
});
