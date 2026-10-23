/**
 * Conformance for the decision-core purity gate (`apps/api/scripts/check-purity.sh`).
 *
 * The cases run the REAL script against throwaway `apps/api` trees with their
 * own `scripts/purity-roots.txt`, and pin what it refuses: a clock, a random
 * source, an environment read, a timer, a network call, a database handle or
 * a Convex wrapper in a guarded module (nested ones included), a value import
 * from a shell that the manifest does not allow, and a manifest whose roots,
 * shells or allowed names no longer match the tree. The last block reads the
 * real manifest and pins which modules it guards.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const run = promisify(execFile);

const GATE = 'apps/api/scripts/check-purity.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

interface GateRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs the gate over a throwaway `apps/api` holding `manifest` and `files`. */
async function gate(
	manifest: string | null,
	files: Record<string, string>,
	args: string[] = []
): Promise<GateRun> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-purity-gate-'));
	roots.push(root);
	const api = join(root, 'apps/api');
	await mkdir(join(api, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));
	if (manifest !== null) await writeFile(join(api, 'scripts/purity-roots.txt'), manifest, 'utf8');
	for (const [path, contents] of Object.entries(files)) {
		const target = join(api, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	try {
		const { stdout, stderr } = await run('bash', [GATE, ...args], { cwd: root });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
	}
}

const CLEAN = 'export function decide(at: number): number {\n\treturn at + 1;\n}\n';

/** Lines naming a failure, without the shared prefix. */
function failures(result: GateRun): string[] {
	return result.stderr
		.split('\n')
		.filter((line) => line.startsWith('FAIL: '))
		.map((line) => line.slice('FAIL: '.length));
}

describe('per-module rules', () => {
	const offenders: Array<[string, string]> = [
		['a clock', 'export const at = Date.now();'],
		['a clock', 'export const at = new Date();'],
		['a clock', 'export const at = performance.now();'],
		['randomness', 'export const roll = Math.random();'],
		['randomness', 'export const id = crypto.randomUUID();'],
		['an environment read', 'export const key = process.env.KEY;'],
		['an environment read', "import { getOptional } from '../../lib/env';"],
		['an environment read', "import { getOptional } from '../env';"],
		['a timer', 'setTimeout(() => {}, 10);'],
		['a timer', 'export const tick = setInterval(() => {}, 10);'],
		['a network call', "export const res = fetch('https://owlat.example');"],
		['a database handle', 'export const load = (ctx: unknown) => ctx;'],
		['a database handle', 'export const rows = db.get(id);'],
		['a Convex function wrapper', 'export const read = query({ handler: () => null });'],
		['a Convex function wrapper', 'export const run = internalAction({ handler: () => null });'],
	];

	it.each(offenders)('refuses %s: %s', async (name, line) => {
		const result = await gate('convex/core\n', {
			'convex/core/decide.ts': `${CLEAN}${line}\n`,
		});
		expect(result.code).toBe(1);
		expect(failures(result)).toEqual([
			expect.stringMatching(new RegExp(`^convex/core/decide\\.ts contains ${name} \\(`)),
		]);
	});

	it('checks nested modules of a guarded directory and guarded single files', async () => {
		const result = await gate('convex/core\nconvex/other/reducer.ts\n', {
			'convex/core/deep/nested/decide.ts': 'export const at = Date.now();\n',
			'convex/other/reducer.ts': 'export const roll = Math.random();\n',
			'convex/other/runner.ts': 'export const at = Date.now();\n',
		});
		expect(failures(result)).toEqual([
			expect.stringMatching(/^convex\/core\/deep\/nested\/decide\.ts contains a clock/),
			expect.stringMatching(/^convex\/other\/reducer\.ts contains randomness/),
		]);
	});

	it('exempts comments, tests, generated code and shells', async () => {
		const result = await gate('convex/core\n!convex/core/runner.ts\n', {
			'convex/core/decide.ts': [
				'// The caller passes Date.now(); ctx stays in the runner.',
				'/* Math.random() and process.env belong to the shell,',
				'   as does setTimeout(). */',
				"export const docs = 'owlat.example'; // fetch(url) is the runner's",
				CLEAN,
			].join('\n'),
			'convex/core/__tests__/decide.test.ts': 'const at = Date.now();\n',
			'convex/core/decide.test.ts': 'const at = Date.now();\n',
			'convex/core/_generated/api.ts': 'const at = Date.now();\n',
			'convex/core/runner.ts': 'export const run = (ctx: unknown) => Date.now();\n',
		});
		expect(failures(result)).toEqual([]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('check-purity: OK (1 modules)\n');
	});
});

describe('the shell boundary', () => {
	const SHELL =
		'export const pureName = (n: number) => n * 2;\n' +
		'export function load(ctx: { db: unknown }) {\n\treturn ctx.db;\n}\n' +
		'export type Effect = { kind: string };\n' +
		'export default load;\n';

	it('refuses a value import from a shell the manifest does not allow', async () => {
		const result = await gate('convex/core\n!convex/core/runner.ts\n', {
			'convex/core/runner.ts': SHELL,
			'convex/core/reducer.ts': "import { load } from './runner';\n",
		});
		expect(failures(result)).toEqual([
			expect.stringMatching(
				/^convex\/core\/reducer\.ts imports load from the shell convex\/core\/runner\.ts/
			),
		]);
	});

	it('reads multi-line, aliased, default, namespace and re-export forms', async () => {
		const result = await gate('convex/core\n!convex/core/runner.ts\n', {
			'convex/core/runner.ts': SHELL,
			'convex/core/a.ts': "import {\n\tpureName,\n\tload as loadSend,\n} from './runner';\n",
			'convex/core/b.ts': "import loadDefault from './runner';\n",
			'convex/core/c.ts': "import * as runner from './runner';\n",
			'convex/core/deep/d.ts': "export { load } from '../runner';\n",
		});
		expect(failures(result).map((line) => line.split(' from ')[0])).toEqual([
			'convex/core/a.ts imports pureName',
			'convex/core/a.ts imports load',
			'convex/core/b.ts imports default',
			'convex/core/c.ts imports *',
			'convex/core/deep/d.ts imports load',
		]);
	});

	it('allows type imports and the names listed after the shell', async () => {
		const result = await gate('convex/core\n!convex/core/runner.ts pureName\n', {
			'convex/core/runner.ts': SHELL,
			'convex/core/reducer.ts': [
				"import type { Effect } from './runner';",
				"import { pureName, type Effect as RunnerEffect } from './runner';",
				"export type { Effect as E } from './runner';",
				'export const twice: (n: number) => number = pureName;',
				'export type Both = Effect | RunnerEffect;',
				'',
			].join('\n'),
		});
		expect(failures(result)).toEqual([]);
		expect(result.code).toBe(0);
	});

	it('refuses an allowed name no guarded module imports any more', async () => {
		const result = await gate('convex/core\n!convex/core/runner.ts pureName\n', {
			'convex/core/runner.ts': SHELL,
			'convex/core/reducer.ts': CLEAN,
		});
		expect(failures(result)).toEqual([
			expect.stringMatching(
				/^scripts\/purity-roots\.txt allows pureName from convex\/core\/runner\.ts but no guarded module imports it/
			),
		]);
	});
});

describe('the manifest', () => {
	it('fails without a manifest or without a root', async () => {
		const missing = await gate(null, { 'convex/core/decide.ts': CLEAN });
		expect(missing.code).toBe(1);
		expect(missing.stderr).toMatch(/purity-roots\.txt missing/);

		const empty = await gate('# nothing guarded\n\n', { 'convex/core/decide.ts': CLEAN });
		expect(empty.code).toBe(1);
		expect(empty.stderr).toMatch(/lists no roots/);
	});

	it('fails on a missing root, an empty root and a root that is not a production module', async () => {
		const result = await gate(
			'convex/moved\nconvex/empty\nconvex/core/__tests__/x.test.ts\nconvex/core\n',
			{
				'convex/empty/__tests__/only.test.ts': CLEAN,
				'convex/core/__tests__/x.test.ts': CLEAN,
				'convex/core/decide.ts': CLEAN,
			}
		);
		expect(failures(result)).toEqual([
			'root convex/moved missing — the decision core moved',
			'root convex/empty holds no production module — the decision core moved',
			'root convex/core/__tests__/x.test.ts is not a production TypeScript module',
		]);
	});

	it('fails on a shell that is missing, outside a guarded directory or listed twice', async () => {
		const result = await gate(
			'convex/core\nconvex/single.ts\n!convex/core/gone.ts\n!convex/single.ts\n!convex/core/runner.ts\n!convex/core/runner.ts\n',
			{
				'convex/core/decide.ts': CLEAN,
				'convex/core/runner.ts': CLEAN,
				'convex/single.ts': CLEAN,
			}
		);
		expect(failures(result)).toEqual([
			'scripts/purity-roots.txt:6 lists the shell convex/core/runner.ts twice',
			'shell convex/core/gone.ts missing — delete its line from scripts/purity-roots.txt',
			'shell convex/single.ts is not inside a guarded directory — delete its line from scripts/purity-roots.txt',
		]);
	});

	it('refuses names on a root line', async () => {
		const result = await gate('convex/core pureName\n', { 'convex/core/decide.ts': CLEAN });
		expect(failures(result)).toEqual([
			'scripts/purity-roots.txt:1: a root takes no names (convex/core pureName)',
		]);
	});
});

describe('the real manifest', () => {
	async function guardedModules(): Promise<string[]> {
		const { stdout } = await run('bash', [GATE, '--list'], { cwd: REPOSITORY_ROOT });
		return stdout.split('\n').filter((line) => line.length > 0);
	}

	it('passes on the tree', async () => {
		const { stdout } = await run('bash', [GATE], { cwd: REPOSITORY_ROOT });
		expect(stdout).toMatch(/^check-purity: OK \(\d+ modules\)\n$/);
	});

	it('guards the ramp, the lifecycle reducers and the decision plane rules', async () => {
		const guarded = await guardedModules();
		expect(guarded).toEqual(
			expect.arrayContaining([
				'convex/delivery/ramp/gates.ts',
				'convex/delivery/signals/rampGateSources.ts',
				'convex/lib/lifecycle.ts',
				'convex/mail/draftLifecycle/reducers.ts',
				'convex/mail/draftLifecycle/types.ts',
				'convex/delivery/sendLifecycle/reducers.ts',
				'convex/delivery/sendLifecycle/feedbackReducers.ts',
				'convex/delivery/sendLifecycle/deliveryObservation.ts',
				'convex/inbox/processingLifecycle/reducers.ts',
				'convex/domains/lifecycleReducer.ts',
				'convex/lib/decision/contract.ts',
				'convex/lib/decision/routing.ts',
				'convex/lib/decision/pricing.ts',
				'convex/lib/decision/questions.ts',
			])
		);
	});

	it('keeps the effect runners and ctx-bound ports outside the guarded set', async () => {
		const guarded = await guardedModules();
		for (const shell of [
			'convex/mail/draftLifecycle/effects.ts',
			'convex/delivery/sendLifecycle/effects.ts',
			'convex/delivery/sendLifecycle/lookups.ts',
			'convex/inbox/processingLifecycle/effects.ts',
			'convex/lib/decision/dispatch.ts',
			'convex/lib/decision/ports.ts',
		]) {
			expect(guarded).not.toContain(shell);
		}
		expect(guarded.some((file) => file.includes('__tests__') || file.endsWith('.test.ts'))).toBe(
			false
		);
	});
});
