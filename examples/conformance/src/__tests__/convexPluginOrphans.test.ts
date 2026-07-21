/**
 * The guard on the Convex plugin-host dead-code gate.
 *
 * `scripts/check-convex-plugin-orphans.ts` exists because knip cannot see the
 * Convex tree — every file there is a runtime entrypoint, so `knip.jsonc`
 * declares the whole directory as `entry` and an orphaned composition seam can
 * never be reported. A gate that nobody exercises would inherit exactly the
 * blind spot it was written to close, so it is run here against throwaway trees
 * that contain the shapes it must catch, in the same spirit as
 * `dockerWorkspaces.test.ts`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AWAITING_CALL_SITE,
	findConvexPluginOrphanFailures,
} from '../../../../scripts/check-convex-plugin-orphans';
import { REPOSITORY_ROOT } from '../repository';

const PLUGINS_DIR = 'apps/api/convex/plugins';
const created: string[] = [];

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway repository containing exactly the given files. */
async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-orphan-gate-'));
	created.push(root);
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), contents, 'utf8');
	}
	return root;
}

describe('convex plugin-host orphan gate', () => {
	it('passes on the real repository', async () => {
		expect(await findConvexPluginOrphanFailures()).toEqual([]);
	});

	it('keeps every allowlisted seam a real module with a stated reason', async () => {
		for (const [name, reason] of Object.entries(AWAITING_CALL_SITE)) {
			expect(reason.length, `${name} must say what is missing`).toBeGreaterThan(20);
		}
		const failures = await findConvexPluginOrphanFailures({ root: REPOSITORY_ROOT });
		expect(failures).toEqual([]);
	});

	it('reports a seam that nothing imports or addresses', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/orphanSeam.ts`]: 'export const authorize = () => true;\n',
			'apps/api/convex/somewhere.ts': "export const unrelated = 'x';\n",
		});
		const failures = await findConvexPluginOrphanFailures({ root, awaitingCallSite: {} });
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain('orphanSeam.ts has no production consumer');
	});

	it('accepts a seam reached by a relative import', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/wiredSeam.ts`]: 'export const authorize = () => true;\n',
			'apps/api/convex/host.ts':
				"import { authorize } from './plugins/wiredSeam';\nvoid authorize;\n",
		});
		expect(await findConvexPluginOrphanFailures({ root, awaitingCallSite: {} })).toEqual([]);
	});

	it('accepts a seam reached only by generated function reference', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/mutationSeam.ts`]: 'export const authorize = 1;\n',
			'apps/api/convex/host.ts':
				'await ctx.runMutation(internal.plugins.mutationSeam.authorize, {});\n',
		});
		expect(await findConvexPluginOrphanFailures({ root, awaitingCallSite: {} })).toEqual([]);
	});

	it('accepts a seam reached only by the out-of-process worker client', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/workerSeam.ts`]: 'export const claim = 1;\n',
			'apps/code-worker/src/client.ts': "const claim = fn('plugins/workerSeam:claim');\n",
		});
		expect(await findConvexPluginOrphanFailures({ root, awaitingCallSite: {} })).toEqual([]);
	});

	it('does not count a test or a generated file as a consumer', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/testOnlySeam.ts`]: 'export const authorize = 1;\n',
			[`${PLUGINS_DIR}/__tests__/testOnlySeam.test.ts`]:
				"import { authorize } from '../testOnlySeam';\nvoid authorize;\n",
			[`${PLUGINS_DIR}/catalog.generated.ts`]:
				"import { authorize } from './testOnlySeam';\nvoid authorize;\n",
			'apps/api/convex/host.ts': "export const unrelated = 'x';\n",
		});
		const failures = await findConvexPluginOrphanFailures({ root, awaitingCallSite: {} });
		expect(failures.join('\n')).toContain('testOnlySeam.ts has no production consumer');
	});

	it('fails when an allowlisted seam quietly acquires a consumer', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/deferredSeam.ts`]: 'export const authorize = () => true;\n',
			'apps/api/convex/host.ts':
				"import { authorize } from './plugins/deferredSeam';\nvoid authorize;\n",
		});
		const failures = await findConvexPluginOrphanFailures({
			root,
			awaitingCallSite: {
				deferredSeam: 'the publish path that would call this is not written yet',
			},
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain('still listed as awaiting a call site');
	});

	it('fails on a stale allowlist entry', async () => {
		const root = await fixture({
			[`${PLUGINS_DIR}/liveSeam.ts`]: 'export const authorize = () => true;\n',
			'apps/api/convex/host.ts':
				"import { authorize } from './plugins/liveSeam';\nvoid authorize;\n",
		});
		const failures = await findConvexPluginOrphanFailures({
			root,
			awaitingCallSite: { deletedSeam: 'this module was removed in a later piece of the program' },
		});
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain('remove the stale entry');
	});

	it('fails loudly rather than passing when it finds nothing to check', async () => {
		const root = await fixture({ 'apps/api/convex/host.ts': "export const x = 'x';\n" });
		const failures = await findConvexPluginOrphanFailures({ root, awaitingCallSite: {} });
		expect(failures[0]).toContain('the gate is not searching anything');
	});
});
