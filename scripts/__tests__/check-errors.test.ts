/**
 * Conformance for the Operation error taxonomy gate
 * (`apps/api/scripts/check-errors.sh`).
 *
 * The gate spent its life keyed on `export const X = (query|mutation|action)(`,
 * a shape `check-public-functions.sh` bans everywhere outside
 * `lib/authedFunctions.ts` — so it matched nothing and printed `ok:` over
 * fifteen bare throws in user-facing handlers. A gate whose subject set can go
 * empty without the gate noticing has to be exercised against code, which is
 * what happens here: the REAL script, copied into a throwaway `apps/api` tree
 * whose `convex/` files are written per case.
 *
 * The cases pin both directions — the builders that must be caught (the
 * secure-by-default ones actually in use, including the feature-gated pairs)
 * and the ones that must not be (internal* and plain helpers, whose bare throws
 * are invariant bugs that never reach a client).
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

const GATE = 'apps/api/scripts/check-errors.sh';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

interface GateResult {
	readonly code: number;
	readonly output: string;
}

/** Build an `apps/api` tree holding the real gate plus `files`, and run it. */
async function runGate(files: Record<string, string>): Promise<GateResult> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-errors-gate-'));
	roots.push(root);

	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, 'apps/api', path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));

	try {
		const { stdout, stderr } = await run('bash', [GATE], { cwd: root });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

/** A module exporting one function built with `builder`, throwing a bare Error. */
function moduleWithBareThrow(builder: string): string {
	return [
		`export const rename = ${builder}({`,
		'\targs: {},',
		'\thandler: async (ctx, args) => {',
		"\t\tif (!args.name) throw new Error('A name is required');",
		'\t\treturn null;',
		'\t},',
		'});',
		'',
	].join('\n');
}

describe('convex operation-error taxonomy gate', () => {
	it('flags a bare throw inside an authedMutation', async () => {
		const result = await runGate({
			'convex/workspaces/settings.ts': moduleWithBareThrow('authedMutation'),
		});

		expect(result.code).toBe(1);
		expect(result.output).toContain('convex/workspaces/settings.ts:4');
		expect(result.output).toContain('A name is required');
	});

	// Every builder a user-facing function is actually written with today. The
	// bare `mutation(` at the end is the one the gate used to key on alone.
	it.each([
		'authedQuery',
		'authedMutation',
		'authedAction',
		'authedIdentityMutation',
		'adminQuery',
		'adminMutation',
		'ownerMutation',
		'publicQuery',
		'publicMutation',
		'publicAction',
		'chatQuery',
		'chatMutation',
		'assistantQuery',
		'assistantMutation',
		'mutation',
	])('flags a bare throw inside a %s', async (builder) => {
		const result = await runGate({ 'convex/thing.ts': moduleWithBareThrow(builder) });

		expect(result.code).toBe(1);
		expect(result.output).toContain('A name is required');
	});

	it.each(['internalQuery', 'internalMutation', 'internalAction'])(
		'allows a bare throw inside a %s — an invariant bug, never surfaced',
		async (builder) => {
			const result = await runGate({ 'convex/thing.ts': moduleWithBareThrow(builder) });

			expect(result.code).toBe(0);
			expect(result.output).toContain('ok:');
		}
	);

	it('allows a bare throw in a plain helper outside any handler', async () => {
		const result = await runGate({
			'convex/thing.ts': [
				'function assertName(name: string) {',
				"\tif (!name) throw new Error('A name is required');",
				'}',
				'',
			].join('\n'),
		});

		expect(result.code).toBe(0);
	});

	it('accepts the taxonomy thrower in place of the bare Error', async () => {
		const result = await runGate({
			'convex/thing.ts': [
				"import { throwInvalidInput } from './_utils/errors';",
				'',
				'export const rename = authedMutation({',
				'\targs: {},',
				'\thandler: async (ctx, args) => {',
				"\t\tif (!args.name) throwInvalidInput('A name is required');",
				'\t\treturn null;',
				'\t},',
				'});',
				'',
			].join('\n'),
		});

		expect(result.code).toBe(0);
	});

	it('does not read test files or generated code', async () => {
		const result = await runGate({
			'convex/__tests__/thing.test.ts': moduleWithBareThrow('authedMutation'),
			'convex/_generated/server.ts': moduleWithBareThrow('authedMutation'),
		});

		expect(result.code).toBe(0);
	});

	it('still bans a hand-rolled ConvexError outside _utils/errors.ts', async () => {
		const result = await runGate({
			'convex/thing.ts': "throw new ConvexError({ code: 'NOPE' });\n",
		});

		expect(result.code).toBe(1);
		expect(result.output).toContain('new ConvexError');
	});
});
