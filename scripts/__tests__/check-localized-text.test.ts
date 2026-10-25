/**
 * Conformance for the LocalizedText gate (`apps/web/scripts/check-localized-text.sh`).
 *
 * The gate has no baseline: it hands its findings to `scripts/ratchet.sh
 * --zero`, so any one fails. The first cases run the REAL script's
 * `--generate` half against throwaway `apps/web` trees and pin what it
 * reports: a restated `LocalizedText` type or
 * interface, the `string | { key; params }` union under any other name, and an
 * inline `params ?? {})` resolver, anywhere under app/ or server/ outside
 * `app/utils/localizedText.ts` and tests. Prose that names a spelling is not
 * code and is not reported.
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

const RATCHET = 'scripts/ratchet.sh';
const GATE = 'apps/web/scripts/check-localized-text.sh';

const UNION = 'string | { key: string; params?: Record<string, unknown> }';

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	roots.length = 0;
});

/**
 * A throwaway repository holding the REAL gate, the REAL ratchet runner it
 * execs, and `files` under `apps/web/`. `bare` leaves out the source roots the
 * generator scans.
 */
async function tree(files: Record<string, string>, bare = false): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-web-gate-'));
	roots.push(root);

	if (!bare) {
		await mkdir(join(root, 'apps/web/app'), { recursive: true });
		await mkdir(join(root, 'apps/web/server'), { recursive: true });
	}
	for (const [path, contents] of Object.entries(files)) {
		const target = join(root, 'apps/web', path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, 'utf8');
	}
	await mkdir(join(root, 'apps/web/scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, GATE), join(root, GATE));
	await mkdir(join(root, 'scripts'), { recursive: true });
	await copyFile(join(REPOSITORY_ROOT, RATCHET), join(root, RATCHET));
	return root;
}

/** `file:spelling` entries the gate reports for a throwaway tree holding `files`. */
async function violations(files: Record<string, string>): Promise<string[]> {
	const { stdout } = await run('bash', [GATE, '--generate'], { cwd: await tree(files) });
	return stdout.split('\n').filter((line) => line.length > 0);
}

/** Run the whole gate (generator plus runner) in `root`. */
async function gate(root: string): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await run('bash', [GATE], { cwd: root });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

describe('web LocalizedText ratchet', () => {
	it('reports a restated type, interface, union and resolver by file', async () => {
		expect(
			await violations({
				'app/utils/copy.ts': `export type LocalizedText = ${UNION};\n`,
				'app/composables/labels.ts': 'export interface LocalizedText {\n\tkey: string;\n}\n',
				'app/utils/brief.ts': `export type BriefText = ${UNION};\n`,
				'app/components/Card.vue': [
					'<script setup lang="ts">',
					'const localized = (value: Message): string =>',
					"\ttypeof value === 'string' ? t(value) : t(value.key, value.params ?? {});",
					'</script>',
					'',
				].join('\n'),
				'server/utils/render.ts': 'const out = t(line.key, line.params ?? {});\n',
			})
		).toEqual([
			'app/components/Card.vue:params ?? {})',
			'app/composables/labels.ts:interface LocalizedText',
			'app/utils/brief.ts:string | { key, params } union',
			'app/utils/copy.ts:string | { key, params } union',
			'app/utils/copy.ts:type LocalizedText =',
			'server/utils/render.ts:params ?? {})',
		]);
	});

	it('reports every occurrence, so a second resolver in one file is new', async () => {
		expect(
			await violations({
				'app/pages/a.vue': 'a(x.params ?? {});\nb(y.params ?? {});\n',
			})
		).toEqual(['app/pages/a.vue:params ?? {})', 'app/pages/a.vue:params ?? {})']);
	});

	it('exempts the shared module and tests', async () => {
		const copy = `export type LocalizedText = ${UNION};\nt(v.key, v.params ?? {});\n`;
		expect(
			await violations({
				'app/utils/localizedText.ts': copy,
				'app/utils/__tests__/copy.test.ts': copy,
				'app/components/delivery/__tests__/harness.ts': copy,
				'app/lib/copy.test.ts': copy,
			})
		).toEqual([]);
	});

	it('ignores prose that names a spelling, and code that uses the helper', async () => {
		expect(
			await violations({
				'app/components/Row.vue': [
					'<script setup lang="ts">',
					'// never t(v.key, v.params ?? {}) inline',
					' * nor type LocalizedText = …',
					"import { useLocalized } from '~/composables/useLocalized';",
					"import type { LocalizedText } from '~/utils/localizedText';",
					'export type RowText = LocalizedText;',
					'const localized = useLocalized();',
					'</script>',
					'',
				].join('\n'),
			})
		).toEqual([]);
	});
});

describe('web LocalizedText ratchet, as a gate with no baseline', () => {
	it('passes a clean tree without any baseline file', async () => {
		const result = await gate(
			await tree({
				'app/utils/copy.ts':
					"import type { LocalizedText } from '~/utils/localizedText';\nexport type CopyText = LocalizedText;\n",
			})
		);
		expect(result.output).toContain('(no baseline, none allowed)');
		expect(result.code).toBe(0);
	});

	it('fails a tree with one occurrence and names it', async () => {
		const result = await gate(
			await tree({ 'server/utils/render.ts': 'const out = t(line.key, line.params ?? {});\n' })
		);
		expect(result.code).toBe(1);
		expect(result.output).toContain(
			'FAIL: 1 copy/copies of LocalizedText or its resolver outside app/utils/localizedText.ts:'
		);
		expect(result.output).toContain('server/utils/render.ts:');
	});

	it('propagates a generator failure instead of passing an empty tree', async () => {
		const result = await gate(await tree({}, true));
		expect(result.code).toBe(1);
		expect(result.output).toContain('app/ or server/ missing');
		expect(result.output).not.toContain('ok:');
	});

	it('refuses to seed a baseline with --write-baseline', async () => {
		const root = await tree({
			'server/utils/render.ts': 'const out = t(line.key, line.params ?? {});\n',
		});
		await expect(run('bash', [GATE, '--write-baseline'], { cwd: root })).rejects.toMatchObject({
			code: 2,
		});
	});
});
