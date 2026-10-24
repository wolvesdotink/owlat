/**
 * Conformance for the action commit ratchet
 * (`apps/api/scripts/check-action-commits.sh`).
 *
 * The census (`apps/api/scripts/lib/actionCommits.ts`) counts the most
 * `runMutation` calls one run of an action can make. These cases pin how it
 * reads code — comments and strings are not calls, alternative branches and
 * early returns are not added up, loops, per-item callbacks and switch
 * fall-through are, same-module helpers are followed by lexical scope, also
 * when handed over by name — and where a `// checkpoint:` marker may sit. The last
 * block runs the real gate, once against a throwaway tree to see the ratchet
 * fail in both directions and once against the repository itself. The census
 * is driven through its CLI (`--stdin`), the way the gate runs it.
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
const CENSUS = join(REPOSITORY_ROOT, 'apps/api/scripts/action-commit-census.ts');
const run = promisify(execFile);

// Every case runs the census in a bun subprocess.
vi.setConfig({ testTimeout: PARALLEL_GATE_TIMEOUT_MS });

interface ModuleCensus {
	readonly actions: ReadonlyArray<{ module: string; name: string; commits: number }>;
	readonly problems: readonly string[];
}

/** The real census of one module, through the CLI's `--stdin` mode. */
function censusModule(module: string, source: string): ModuleCensus {
	const result = spawnSync('bun', [CENSUS, '--stdin', module], { input: source, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`census exited ${result.status}: ${result.stderr}`);
	return JSON.parse(result.stdout) as ModuleCensus;
}

/** The commit count of each action in a module made of `source`. */
function counts(source: string): Record<string, number> {
	const census = censusModule('convex/fixture.ts', source);
	expect(census.problems).toEqual([]);
	return Object.fromEntries(census.actions.map((action) => [action.name, action.commits]));
}

function problems(source: string): readonly string[] {
	return censusModule('convex/fixture.ts', source).problems;
}

/** An internalAction whose handler body is `body`. */
const action = (body: string, name = 'work', builder = 'internalAction'): string =>
	[
		`export const ${name} = ${builder}({`,
		'\targs: {},',
		'\thandler: async (ctx) => {',
		body,
		'\t},',
		'});',
		'',
	].join('\n');

const M = (name: string) => `await ctx.runMutation(internal.x.${name}, {});`;

describe('action commit census — what counts as a commit', () => {
	it('adds up mutations made in sequence', () => {
		expect(counts(action([M('a'), M('b'), M('c')].join('\n')))).toEqual({ work: 3 });
	});

	it('ignores runMutation in comments and strings', () => {
		const body = [
			'// await ctx.runMutation(internal.x.a, {});',
			'/* ctx.runMutation(internal.x.b) */',
			"const note = 'ctx.runMutation(internal.x.c)';",
			'const shown = `ctx.runMutation(${note})`;',
			M('d'),
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('does not count queries, actions or scheduled mutations', () => {
		const body = [
			'await ctx.runQuery(internal.x.q, {});',
			'await ctx.runAction(internal.x.act, {});',
			'await ctx.scheduler.runAfter(0, internal.x.m, {});',
			M('commit'),
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('counts only actions, under every action builder', () => {
		const source = [
			action(`${M('a')}\n${M('b')}`, 'internal', 'internalAction'),
			action(`${M('a')}\n${M('b')}`, 'gated', 'chatAction'),
			action(`${M('a')}\n${M('b')}`, 'member', 'authedAction'),
			action(`${M('a')}\n${M('b')}`, 'mutationOnly', 'internalMutation'),
			`export const hook = httpAction(async (ctx, request) => {\n${M('a')}\n${M('b')}\nreturn new Response();\n});`,
		].join('\n');
		expect(counts(source)).toEqual({ internal: 2, gated: 2, member: 2, hook: 2 });
	});

	it('reads a handler bound to a module-level function', () => {
		const source = [
			`async function run(ctx) {\n${M('a')}\n${M('b')}\n}`,
			'export const work = internalAction({ args: {}, handler: run });',
		].join('\n');
		expect(counts(source)).toEqual({ work: 2 });
	});
});

describe('action commit census — one run, not every line', () => {
	it('takes the costlier side of if/else instead of both', () => {
		const body = `if (blocked) {\n${M('block')}\n} else {\n${M('a')}\n${M('b')}\n}`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('does not add a branch that returns to the code after it', () => {
		const body = `if (blocked) {\n${M('block')}\nreturn;\n}\n${M('commit')}`;
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('does not add a branch that throws to the code after it', () => {
		const body = `if (bad) {\n${M('fail')}\nthrow new Error('x');\n}\n${M('commit')}`;
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('takes the costlier side of a ternary', () => {
		const body = `await (flag ? ctx.runMutation(internal.x.a, {}) : ctx.runMutation(internal.x.b, {}));`;
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('takes the costliest switch clause, and break leaves the switch', () => {
		const body = [
			'switch (kind) {',
			`case 'a': ${M('a')} break;`,
			`case 'b': ${M('b')} ${M('c')} break;`,
			`default: return;`,
			'}',
			M('after'),
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 3 });
	});

	it('adds a switch clause that falls through to the clauses below it', () => {
		const body = [
			'switch (kind) {',
			"case 'both':",
			M('first'),
			'// falls through',
			'default:',
			M('second'),
			'}',
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('stops a fall-through at break, return or throw', () => {
		const body = [
			'switch (kind) {',
			`case 'a': ${M('a')} break;`,
			`case 'b': ${M('b')}`,
			`case 'c': ${M('c')} return;`,
			`case 'd': ${M('d')} throw new Error('x');`,
			`case 'e': ${M('e')}`,
			'}',
			M('after'),
		].join('\n');
		// 'b' falls into 'c' and returns (2); 'e' falls out of the switch (2).
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('adds both sides of && / ||', () => {
		const body = `ok && (await ctx.runMutation(internal.x.a, {}));\nok || (await ctx.runMutation(internal.x.b, {}));`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('adds a catch to what its try may already have committed', () => {
		const body = `try {\n${M('commit')}\nawait fetch('x');\n} catch {\n${M('recordFailure')}\n}`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('adds finally to every path', () => {
		const body = `try {\n${M('commit')}\nreturn;\n} finally {\n${M('release')}\n}`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('counts a mutation in a loop as many', () => {
		expect(counts(action(`for (const item of items) {\n${M('a')}\n}`))).toEqual({ work: 2 });
		expect(counts(action(`while (more) {\n${M('a')}\n}`))).toEqual({ work: 2 });
	});

	it('counts a mutation in a per-item callback as many', () => {
		const body = `await Promise.all(items.map((item) => ctx.runMutation(internal.x.a, { item })));`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('adds each mutation of a Promise.all', () => {
		const body = `await Promise.all([ctx.runMutation(internal.x.a, {}), ctx.runMutation(internal.x.b, {})]);`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});
});

describe('action commit census — helpers', () => {
	it('follows a module-level helper at each call', () => {
		const source = [
			`async function persist(ctx) {\n${M('a')}\n}`,
			action('await persist(ctx);\nawait persist(ctx);'),
		].join('\n');
		expect(counts(source)).toEqual({ work: 2 });
	});

	it('follows a const arrow helper and a named closure in the handler', () => {
		const source = [
			`const persist = async (ctx) => ctx.runMutation(internal.x.a, {});`,
			action(
				'const again = async () => { await ctx.runMutation(internal.x.b, {}); };\nawait persist(ctx);\nawait again();\nawait again();'
			),
		].join('\n');
		expect(counts(source)).toEqual({ work: 3 });
	});

	it('counts a helper handed by name to a per-item callback as many', () => {
		const body = [
			'const persist = async (item) => ctx.runMutation(internal.x.save, { item });',
			'await Promise.all(items.map(persist));',
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 2 });
		const source = [
			`async function persist(ctx, item) {\n${M('a')}\n}`,
			action('await withRetry(persist);'),
		].join('\n');
		expect(counts(source)).toEqual({ work: 1 });
	});

	it('resolves a helper from a closure nested in the function that declares it', () => {
		const body = [
			`const persist = async () => { ${M('a')} };`,
			'const twice = async () => { await persist(); await persist(); };',
			'await twice();',
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('follows an alias, and not a name a parameter shadows', () => {
		const body = [
			`const persist = async () => { ${M('a')} };`,
			'const run = persist;',
			'await run();',
			'const inner = async (persist) => { await persist(); await persist(); };',
			'await inner(noop);',
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('counts a closure that is never called by name where it is written', () => {
		const body = `await withRetry(() => ctx.runMutation(internal.x.a, {}));\n${M('b')}`;
		expect(counts(action(body))).toEqual({ work: 2 });
	});

	it('survives a recursive helper', () => {
		const source = [
			`async function walk(ctx, n) {\n${M('a')}\nif (n > 0) await walk(ctx, n - 1);\n}`,
			action('await walk(ctx, 3);'),
		].join('\n');
		expect(counts(source)).toEqual({ work: 1 });
	});
});

describe('action commit census — // checkpoint: markers', () => {
	it('exempts the call directly under a marker', () => {
		const body = [
			'// checkpoint: one page of a chunked walk; the next page resumes from it',
			M('advance'),
			M('commit'),
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('exempts a call nested in the marked statement, and a multi-line marker', () => {
		const body = [
			'// checkpoint: a lease claimed before the external effect, released by the',
			'// commit below or by its expiry',
			'const lease = await ctx.runMutation(internal.x.claim, {});',
			M('commit'),
		].join('\n');
		expect(counts(action(body))).toEqual({ work: 1 });
	});

	it('reports a marker that sits above no runMutation', () => {
		const body = ['// checkpoint: nothing below writes', 'await fetch("x");', M('commit')].join(
			'\n'
		);
		expect(problems(action(body))).toEqual([
			'convex/fixture.ts:4: a // checkpoint: marker must be a line of its own directly above the statement making the runMutation call it exempts',
		]);
	});

	it('reports a trailing marker and still counts its call', () => {
		const body = `${M('a')} // checkpoint: trailing\n${M('b')}`;
		const census = censusModule('convex/fixture.ts', action(body));
		expect(census.problems).toHaveLength(1);
		expect(census.actions[0]?.commits).toBe(2);
	});

	it('reports a marker without a reason', () => {
		expect(problems(action(`// checkpoint:\n${M('a')}`))).toEqual([
			'convex/fixture.ts:4: a // checkpoint: marker needs a reason (why the write may stand alone)',
		]);
	});

	it('does not read a block comment or prose as a marker', () => {
		const body = `/* checkpoint: not a marker */\n// Advance the checkpoint: patch the cursor\n${M('a')}`;
		expect(problems(action(body))).toEqual([]);
	});
});

describe('check-action-commits.sh', () => {
	const roots: string[] = [];
	afterAll(async () => {
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	});

	/** A throwaway repository holding the real gate, census, ratchet and `files`. */
	async function tree(files: Record<string, string>): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'owlat-action-commits-'));
		roots.push(root);
		for (const path of [
			'scripts/ratchet.sh',
			'apps/api/scripts/check-action-commits.sh',
			'apps/api/scripts/action-commit-census.ts',
			'apps/api/scripts/lib/actionCommits.ts',
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
			const { stdout, stderr } = await run('bash', ['apps/api/scripts/check-action-commits.sh'], {
				cwd: root,
			});
			return { code: 0, output: `${stdout}${stderr}` };
		} catch (error) {
			const failure = error as { code?: number; stdout?: string; stderr?: string };
			return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
		}
	}

	/** Enough actions for the census's sanity floor, each committing `commits` times. */
	function convexTree(commits: number, extra = ''): Record<string, string> {
		const files: Record<string, string> = {};
		for (let i = 0; i < 50; i += 1) files[`apps/api/convex/m${i}.ts`] = action(M('a'), `a${i}`);
		files['apps/api/convex/send.ts'] =
			action(Array.from({ length: commits }, (_, i) => M(`m${i}`)).join('\n'), 'start') + extra;
		return files;
	}

	const BASELINE = 'apps/api/scripts/action-commit-baseline.txt';

	it(
		'passes at the baseline, fails on one more commit and on a stale line',
		async () => {
			const baseline = '# debt\nconvex/send.ts:start #2\nconvex/send.ts:start #3\n';

			const atBaseline = await gate(await tree({ ...convexTree(3), [BASELINE]: baseline }));
			expect(atBaseline.output).toContain('2 baseline entries remain');
			expect(atBaseline.code).toBe(0);

			const grown = await gate(await tree({ ...convexTree(4), [BASELINE]: baseline }));
			expect(grown.code).toBe(1);
			expect(grown.output).toContain('convex/send.ts:start #4');

			const shrunk = await gate(await tree({ ...convexTree(2), [BASELINE]: baseline }));
			expect(shrunk.code).toBe(1);
			expect(shrunk.output).toMatch(/stale[\s\S]*convex\/send\.ts:start #3/);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

	it(
		'fails on a misplaced checkpoint marker',
		async () => {
			const root = await tree({
				...convexTree(1, '\n// checkpoint: exempts nothing\nexport const x = 1;\n'),
				[BASELINE]: '# debt\n',
			});
			const result = await gate(root);
			expect(result.code).toBe(1);
			expect(result.output).toContain('convex/send.ts:8: a // checkpoint: marker must be');
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

	it(
		'passes on this repository',
		async () => {
			const { stdout } = await run('bash', ['apps/api/scripts/check-action-commits.sh'], {
				cwd: REPOSITORY_ROOT,
			});
			expect(stdout).toMatch(/^ok: /m);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);
});
