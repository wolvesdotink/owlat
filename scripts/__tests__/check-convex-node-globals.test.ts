/**
 * The guard on the Convex isolate-runtime Node-global gate.
 *
 * `scripts/check-convex-node-globals.ts` exists because `Buffer` in a V8-runtime
 * Convex module is invisible to every other check the repository has: it type-
 * checks (the Node types are in scope), it bundles, and it passes under vitest,
 * which runs in Node. It only fails in production, once per call. A gate for
 * that has to be exercised itself, or it inherits the same blind spot — so it
 * runs here against throwaway trees carrying each shape it must catch AND each
 * shape it must not, in the same spirit as `check-convex-plugin-orphans.test.ts`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findConvexNodeGlobalUses } from '../check-convex-node-globals';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const CONVEX = 'apps/api/convex';
const created: string[] = [];

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway repository containing exactly the given files. */
async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-node-globals-gate-'));
	created.push(root);
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), contents, 'utf8');
	}
	return root;
}

describe('convex isolate-runtime Node-global gate', () => {
	it('passes on the real repository', async () => {
		expect(await findConvexNodeGlobalUses({ root: REPOSITORY_ROOT })).toEqual([]);
	});

	it('reports a Buffer used in a V8-runtime module', async () => {
		const root = await fixture({
			[`${CONVEX}/mail/ingest.ts`]:
				"export const decode = (b64: string) => Buffer.from(b64, 'base64');\n",
		});

		const uses = await findConvexNodeGlobalUses({ root });

		expect(uses).toHaveLength(1);
		expect(uses[0]).toMatchObject({
			file: `${CONVEX}/mail/ingest.ts`,
			line: 1,
			symbol: 'Buffer',
			reachedFrom: `${CONVEX}/mail/ingest.ts`,
		});
	});

	it('ignores a Buffer in a type position, which is erased before the bundle', async () => {
		const root = await fixture({
			[`${CONVEX}/mail/scan.ts`]: [
				'export interface Part {',
				'\tbytes: Buffer;',
				'}',
				'export function size(raw: Buffer): number {',
				'\treturn raw.byteLength;',
				'}',
				'',
			].join('\n'),
		});

		expect(await findConvexNodeGlobalUses({ root })).toEqual([]);
	});

	it('ignores a Buffer inside a Node-runtime module', async () => {
		const root = await fixture({
			[`${CONVEX}/mail/nodeOnly.ts`]:
				"'use node';\n\nexport const decode = (b64: string) => Buffer.from(b64, 'base64');\n",
		});

		expect(await findConvexNodeGlobalUses({ root })).toEqual([]);
	});

	it('does not follow a value import into a Node-runtime module', async () => {
		const root = await fixture({
			[`${CONVEX}/mail/nodeOnly.ts`]: "'use node';\n\nexport const pad = () => Buffer.alloc(4);\n",
			[`${CONVEX}/mail/caller.ts`]: [
				"import { pad } from './nodeOnly';",
				'export const run = () => pad();',
				'',
			].join('\n'),
		});

		expect(await findConvexNodeGlobalUses({ root })).toEqual([]);
	});

	it('does not follow a type-only import', async () => {
		// Only a workspace source can be spared by reachability: every file under
		// the Convex directory is a module the deployment bundles on its own.
		const root = await fixture({
			'packages/shared/src/mime.ts': [
				'export type Shape = { size: number };',
				'export const pad = () => Buffer.alloc(4);',
				'',
			].join('\n'),
			[`${CONVEX}/mail/caller.ts`]: [
				"import type { Shape } from '@owlat/shared/mime';",
				'export const run = (shape: Shape) => shape.size;',
				'',
			].join('\n'),
		});

		expect(await findConvexNodeGlobalUses({ root })).toEqual([]);
	});

	it('reaches a workspace source through an intermediate Convex module', async () => {
		const root = await fixture({
			'packages/shared/src/mime.ts': 'export const pad = () => Buffer.alloc(4);\n',
			[`${CONVEX}/lib/helper.ts`]: [
				"import { pad } from '@owlat/shared/mime';",
				'export const helper = () => pad();',
				'',
			].join('\n'),
			[`${CONVEX}/mail/entry.ts`]: [
				"import { helper } from '../lib/helper';",
				'export const run = () => helper();',
				'',
			].join('\n'),
		});

		const uses = await findConvexNodeGlobalUses({ root });

		expect(uses).toHaveLength(1);
		expect(uses[0]).toMatchObject({
			file: 'packages/shared/src/mime.ts',
			symbol: 'Buffer',
			reachedFrom: `${CONVEX}/lib/helper.ts`,
		});
	});

	it('follows a workspace @owlat import into packages/', async () => {
		const root = await fixture({
			'packages/shared/src/mime.ts': 'export const pad = () => Buffer.alloc(4);\n',
			[`${CONVEX}/mail/entry.ts`]: [
				"import { pad } from '@owlat/shared/mime';",
				'export const run = () => pad();',
				'',
			].join('\n'),
		});

		const uses = await findConvexNodeGlobalUses({ root });

		expect(uses).toHaveLength(1);
		expect(uses[0]).toMatchObject({
			file: 'packages/shared/src/mime.ts',
			reachedFrom: `${CONVEX}/mail/entry.ts`,
		});
	});

	it('reports a node: builtin imported by a V8-runtime module', async () => {
		const root = await fixture({
			[`${CONVEX}/delivery/sign.ts`]: [
				"import { createHmac } from 'node:crypto';",
				"export const sign = (v: string) => createHmac('sha256', 'k').update(v).digest('hex');",
				'',
			].join('\n'),
		});

		const uses = await findConvexNodeGlobalUses({ root });

		expect(uses).toHaveLength(1);
		expect(uses[0]).toMatchObject({ symbol: 'node:crypto', line: 1 });
	});

	it('ignores a name the module declares or imports for itself', async () => {
		const root = await fixture({
			[`${CONVEX}/mail/shadow.ts`]: [
				'const Buffer = { alloc: (n: number) => new Uint8Array(n) };',
				'export const pad = () => Buffer.alloc(4);',
				'',
			].join('\n'),
		});

		expect(await findConvexNodeGlobalUses({ root })).toEqual([]);
	});

	it('skips tests and generated code, which never run in the deployment', async () => {
		const root = await fixture({
			[`${CONVEX}/mail/__tests__/ingest.test.ts`]: "const raw = Buffer.from('x');\n",
			[`${CONVEX}/_generated/api.ts`]: "export const raw = Buffer.from('x');\n",
		});

		expect(await findConvexNodeGlobalUses({ root })).toEqual([]);
	});
});
