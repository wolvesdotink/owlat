import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePluginComposition } from '../generate';

const temporaryRoots: string[] = [];

async function createZeroPluginWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-plugin-generate-'));
	temporaryRoots.push(root);
	await mkdir(join(root, 'packages', 'plugin-codegen'), { recursive: true });
	await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
	await writeFile(
		join(root, 'plugins.config.ts'),
		'export default { bundledPluginPackages: [] };\n'
	);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('generated composition freshness', () => {
	it('writes both targets and accepts them in non-writing check mode', async () => {
		const root = await createZeroPluginWorkspace();

		await generatePluginComposition(root);
		const convexPath = join(root, 'apps/api/convex/plugins/plugins.generated.ts');
		const nuxtPath = join(root, 'apps/web/app/plugins/plugin-composition.generated.ts');
		expect(await readFile(convexPath, 'utf8')).toContain('composeBundledPlugins([]);');
		expect(await readFile(nuxtPath, 'utf8')).toContain('defineNuxtPlugin');
		await expect(generatePluginComposition(root, { check: true })).resolves.toBeUndefined();
	});

	it('reports every stale or missing generated target without rewriting it', async () => {
		const root = await createZeroPluginWorkspace();
		const convexPath = join(root, 'apps/api/convex/plugins/plugins.generated.ts');
		await mkdir(join(root, 'apps/api/convex/plugins'), { recursive: true });
		await writeFile(convexPath, '// stale and must remain unchanged\n');

		await expect(generatePluginComposition(root, { check: true })).rejects.toMatchObject({
			code: 'generated_files_stale',
			details: [
				'apps/api/convex/plugins/plugins.generated.ts',
				'apps/web/app/plugins/plugin-composition.generated.ts',
			],
		});
		expect(await readFile(convexPath, 'utf8')).toBe('// stale and must remain unchanged\n');
	});
});
