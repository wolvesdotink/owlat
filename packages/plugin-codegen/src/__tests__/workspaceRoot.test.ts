import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginCodegenError } from '../errors';
import { findWorkspaceRoot } from '../workspaceRoot';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-workspace-root-'));
	roots.push(root);
	await writeFile(join(root, 'package.json'), '{}');
	await writeFile(join(root, 'plugins.config.ts'), 'export default { bundledPluginPackages: [] };');
	await mkdir(join(root, 'packages', 'plugin-codegen'), { recursive: true });
	return root;
}

describe('findWorkspaceRoot', () => {
	it('returns the root when started at the root', async () => {
		const root = await createWorkspace();
		await expect(findWorkspaceRoot(root)).resolves.toBe(root);
	});

	it('walks upward from a nested subdirectory to the workspace root', async () => {
		const root = await createWorkspace();
		const nested = join(root, 'apps', 'api', 'convex', 'plugins');
		await mkdir(nested, { recursive: true });
		await expect(findWorkspaceRoot(nested)).resolves.toBe(root);
	});

	it('fails closed with workspace_not_found outside any Owlat workspace', async () => {
		const bare = await mkdtemp(join(tmpdir(), 'owlat-not-a-workspace-'));
		roots.push(bare);
		await expect(findWorkspaceRoot(bare)).rejects.toMatchObject({
			code: 'workspace_not_found',
		});
		await expect(findWorkspaceRoot(bare)).rejects.toBeInstanceOf(PluginCodegenError);
	});

	it('does not treat a directory with only some markers as the root', async () => {
		const root = await createWorkspace();
		const child = join(root, 'child');
		// A partial marker set (package.json only) must be skipped in favor of the
		// real root above it, not accepted as a workspace on its own.
		await mkdir(child, { recursive: true });
		await writeFile(join(child, 'package.json'), '{}');
		await expect(findWorkspaceRoot(child)).resolves.toBe(root);
	});
});
