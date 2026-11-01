/**
 * Conformance for the Convex root gate (`apps/api/scripts/check-convex-root.sh`).
 *
 * The root holds a fixed set of files written into the script, with no
 * baseline to extend. These cases run the REAL script and the REAL ratchet
 * runner against throwaway trees: the fixed set passes, any other root file
 * fails (a `.d.ts` included), files in folders are not the gate's business,
 * `--write-baseline` cannot seed an exception, and a missing fixed file fails.
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { API_ROOT, removeTrees, runGate } from './convexGates.testlib';

const GATE = 'check-convex-root.sh';
const RATCHET = fileURLToPath(new URL('../ratchet.sh', import.meta.url));

const FIXED_ROOT = [
	'auth.config.ts',
	'codeWorkTasks.ts',
	'convex.config.ts',
	'crons.ts',
	'env.d.ts',
	'http.ts',
	'schema.ts',
];

const roots: string[] = [];
afterAll(() => removeTrees(roots));

/** A throwaway repository holding the real gate, the real ratchet and `convex/` files. */
async function repo(convexFiles: readonly string[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-convex-root-'));
	roots.push(root);
	for (const path of convexFiles) {
		const file = join(root, 'apps/api/convex', path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, 'export {};\n', 'utf8');
	}
	await mkdir(join(root, 'scripts'), { recursive: true });
	await mkdir(join(root, 'apps/api/scripts'), { recursive: true });
	await copyFile(RATCHET, join(root, 'scripts/ratchet.sh'));
	await copyFile(join(API_ROOT, 'scripts', GATE), join(root, 'apps/api/scripts', GATE));
	return root;
}

describe('check-convex-root.sh', () => {
	it('passes the fixed set with no baseline file', async () => {
		const result = await runGate(await repo(FIXED_ROOT), GATE);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('(no baseline, none allowed)');
	});

	it('leaves modules in domain folders and lib/ alone', async () => {
		const tree = [...FIXED_ROOT, 'segments/segments.ts', 'lib/env.ts', 'lib/types.d.ts'];
		const result = await runGate(await repo(tree), GATE);
		expect(result.code).toBe(0);
	});

	it('fails any other module at the root, a declaration file included', async () => {
		const tree = [...FIXED_ROOT, 'segments.ts', 'globals.d.ts'];
		const result = await runGate(await repo(tree), GATE);
		expect(result.code).toBe(1);
		expect(result.output).toContain('FAIL: 2 file(s) at the Convex root outside its fixed set');
		expect(result.output).toContain('globals.d.ts');
		expect(result.output).toContain('segments.ts');
	});

	it('prints only the files outside the set under --generate', async () => {
		const result = await runGate(await repo([...FIXED_ROOT, 'storage.ts']), GATE, ['--generate']);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe('storage.ts\n');
	});

	it('refuses to seed an exception with --write-baseline', async () => {
		const root = await repo([...FIXED_ROOT, 'storage.ts']);
		const written = await runGate(root, GATE, ['--write-baseline']);
		expect(written.code).toBe(2);
		expect(written.output).toContain('--zero has no baseline to write');
		const rerun = await runGate(root, GATE);
		expect(rerun.code).toBe(1);
		expect(rerun.output).toContain('storage.ts');
	});

	it.each(FIXED_ROOT)('fails when the fixed file %s is missing from the root', async (name) => {
		const root = await repo(FIXED_ROOT);
		await rm(join(root, 'apps/api/convex', name));
		const result = await runGate(root, GATE);
		expect(result.code).toBe(2);
		expect(result.output).toContain(`apps/api/convex/${name} is missing`);
	});
});
