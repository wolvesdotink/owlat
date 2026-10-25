/**
 * Conformance for the handler length ratchet
 * (`apps/api/scripts/check-handler-size.sh`).
 *
 * The census (`apps/api/scripts/lib/handlerSize.ts`) measures the handler of
 * every registered Convex function. These cases pin what it counts as a
 * handler (every builder shape, a handler bound by name, nothing that is not a
 * registration) and how it counts lines (the function's own span, comments
 * and blank lines included). The last block runs the real gate against a
 * throwaway tree, to see the ratchet fail when a tracked handler grows, when a
 * new one crosses the cap and when a tracked one shrinks, and once against the
 * repository itself. The census is driven through its CLI (`--stdin`), the way
 * the gate runs it.
 */

import { execFile, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CENSUS = join(REPOSITORY_ROOT, 'apps/api/scripts/handler-size-census.ts');
const run = promisify(execFile);

// Every case runs the census in a bun subprocess.
vi.setConfig({ testTimeout: PARALLEL_GATE_TIMEOUT_MS });

/** The handler lengths of one module, through the CLI's `--stdin` mode. */
function lengths(source: string): Record<string, number> {
	const result = spawnSync('bun', [CENSUS, '--stdin', 'convex/fixture.ts'], {
		input: source,
		encoding: 'utf8',
	});
	if (result.status !== 0) throw new Error(`census exited ${result.status}: ${result.stderr}`);
	const handlers = JSON.parse(result.stdout) as Array<{ name: string; lines: number }>;
	return Object.fromEntries(handlers.map((handler) => [handler.name, handler.lines]));
}

/** A registration whose handler body is `bodyLines` lines of statements. */
const registration = (name: string, bodyLines: number, builder = 'internalMutation'): string =>
	[
		`export const ${name} = ${builder}({`,
		'\targs: {},',
		'\thandler: async (ctx) => {',
		...Array.from({ length: bodyLines }, (_, i) => `\t\tconst v${i} = ${i};`),
		'\t},',
		'});',
		'',
	].join('\n');

describe('handler size census — what is a handler', () => {
	it('measures the handler of every builder shape', () => {
		const source = [
			registration('internal', 3, 'internalAction'),
			registration('member', 3, 'authedQuery'),
			registration('gated', 3, 'postboxMutation'),
			registration('plain', 3, 'mutation'),
			'export const hook = httpAction(async (ctx, request) => {',
			'\treturn new Response();',
			'});',
		].join('\n');
		// `handler: async (ctx) => {`, three statements, `}`.
		expect(lengths(source)).toEqual({ internal: 5, member: 5, gated: 5, plain: 5, hook: 3 });
	});

	it('measures a handler bound by name where that function is declared', () => {
		const source = [
			'async function run(ctx) {',
			'\tconst a = 1;',
			'\tconst b = 2;',
			'}',
			'export const byName = internalMutation({ args: {}, handler: run });',
			'export const method = internalQuery({',
			'\targs: {},',
			'\tasync handler(ctx) {',
			'\t\treturn 1;',
			'\t},',
			'});',
		].join('\n');
		expect(lengths(source)).toEqual({ byName: 4, method: 3 });
	});

	it('counts comments and blank lines inside the handler', () => {
		const source = [
			'export const work = internalMutation({',
			'\targs: {},',
			'\thandler: async (ctx) => {',
			'\t\t// why this runs first',
			'',
			'\t\t/* and a block',
			'\t\t   comment */',
			'\t\treturn null;',
			'\t},',
			'});',
		].join('\n');
		expect(lengths(source)).toEqual({ work: 7 });
	});

	it('ignores calls that are not registrations', () => {
		const source = [
			'export const helper = makeThing({ handler: async () => { return 1; } });',
			'export const shape = v.object({ handler: v.string() });',
			'function inner() { const nested = internalMutation({ args: {}, handler: async () => {} }); }',
			registration('real', 1),
		].join('\n');
		expect(lengths(source)).toEqual({ real: 3 });
	});
});

describe('check-handler-size.sh', () => {
	const roots: string[] = [];
	afterAll(async () => {
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	});

	/** A throwaway repository holding the real gate, census, ratchet and `files`. */
	async function tree(files: Record<string, string>): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'owlat-handler-size-'));
		roots.push(root);
		for (const path of [
			'scripts/ratchet.sh',
			'apps/api/scripts/check-handler-size.sh',
			'apps/api/scripts/handler-size-census.ts',
			'apps/api/scripts/lib/handlerSize.ts',
			'apps/api/scripts/lib/functionBindings.ts',
			'apps/api/scripts/lib/sourceGraph.ts',
		]) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await copyFile(join(REPOSITORY_ROOT, path), join(root, path));
		}
		// The census imports `typescript`; resolve it from this repository.
		await symlink(join(REPOSITORY_ROOT, 'node_modules'), join(root, 'node_modules'));
		for (const [path, contents] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true });
			await writeFile(join(root, path), contents, 'utf8');
		}
		return root;
	}

	async function gate(root: string): Promise<{ code: number; output: string }> {
		try {
			const { stdout, stderr } = await run('bash', ['apps/api/scripts/check-handler-size.sh'], {
				cwd: root,
			});
			return { code: 0, output: `${stdout}${stderr}` };
		} catch (error) {
			const failure = error as { code?: number; stdout?: string; stderr?: string };
			return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
		}
	}

	/**
	 * Enough short handlers for the census's sanity floor, plus a long `send`
	 * whose body is `sendBody` statements and, optionally, a long `other`.
	 */
	function convexTree(sendBody: number, otherBody = 1): Record<string, string> {
		const short = Array.from({ length: 500 }, (_, i) => registration(`h${i}`, 1)).join('\n');
		return {
			'apps/api/convex/short.ts': short,
			'apps/api/convex/send.ts': registration('send', sendBody),
			'apps/api/convex/other.ts': registration('other', otherBody),
		};
	}

	const BASELINE = 'apps/api/scripts/handler-size-baseline.txt';
	// 300 statements plus the two lines of the function itself.
	const baseline = '# debt\nconvex/send.ts:send 302\n';

	it(
		'passes at the baseline and fails when a tracked handler grows',
		async () => {
			const atBaseline = await gate(await tree({ ...convexTree(300), [BASELINE]: baseline }));
			expect(atBaseline.output).toContain('1 baseline entries remain');
			expect(atBaseline.code).toBe(0);

			const grown = await gate(await tree({ ...convexTree(301), [BASELINE]: baseline }));
			expect(grown.code).toBe(1);
			expect(grown.output).toContain('convex/send.ts:send 303');
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

	it(
		'fails on a new handler over the cap',
		async () => {
			const result = await gate(await tree({ ...convexTree(300, 250), [BASELINE]: baseline }));
			expect(result.code).toBe(1);
			expect(result.output).toContain('convex/other.ts:other 252');
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

	it(
		'fails on a stale line when a tracked handler shrinks or leaves the list',
		async () => {
			const shrunk = await gate(await tree({ ...convexTree(280), [BASELINE]: baseline }));
			expect(shrunk.code).toBe(1);
			expect(shrunk.output).toMatch(/stale[\s\S]*convex\/send\.ts:send 302/);

			const underCap = await gate(await tree({ ...convexTree(10), [BASELINE]: baseline }));
			expect(underCap.code).toBe(1);
			expect(underCap.output).toMatch(/stale[\s\S]*convex\/send\.ts:send 302/);
			expect(underCap.output).not.toContain('convex/send.ts:send 12');
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

	it(
		'refuses a tree whose handlers it cannot find',
		async () => {
			const result = await gate(
				await tree({ 'apps/api/convex/send.ts': registration('send', 300), [BASELINE]: baseline })
			);
			expect(result.code).toBe(1);
			expect(result.output).toContain('found only 1 Convex handlers');
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

	it(
		'passes on this repository',
		async () => {
			const { stdout } = await run('bash', ['apps/api/scripts/check-handler-size.sh'], {
				cwd: REPOSITORY_ROOT,
			});
			expect(stdout).toMatch(/^ok: /m);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);
});
