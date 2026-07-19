import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCreate } from '../commands/create';
import { PluginCliError } from '../errors';
import { captureIo, cleanupCliWorkspaces, createCliWorkspace } from './fixtures';

afterEach(async () => {
	await cleanupCliWorkspaces();
});

const scaffoldDir = join('examples', 'plugins', 'my-plugin');

describe('runCreate', () => {
	it('scaffolds a complete, deterministic plugin package', async () => {
		const root = await createCliWorkspace();
		const { io, lines } = captureIo();
		await runCreate(root, { idInput: 'my-plugin', dryRun: false }, io);

		const files = (await readdir(join(root, scaffoldDir, 'src'))).sort();
		expect(files).toContain('manifest.ts');
		const packageJson = JSON.parse(await readFile(join(root, scaffoldDir, 'package.json'), 'utf8'));
		expect(packageJson.name).toBe('@owlat/plugin-my-plugin');
		expect(lines.some((line) => line.includes('Scaffolded plugin my-plugin'))).toBe(true);
	});

	it('is idempotent: a second run over an identical scaffold writes nothing new', async () => {
		const root = await createCliWorkspace();
		const first = captureIo();
		await runCreate(root, { idInput: 'my-plugin', dryRun: false }, first.io);
		const before = await readFile(join(root, scaffoldDir, 'src', 'manifest.ts'), 'utf8');

		const second = captureIo();
		await runCreate(root, { idInput: 'my-plugin', dryRun: false }, second.io);
		const after = await readFile(join(root, scaffoldDir, 'src', 'manifest.ts'), 'utf8');

		expect(after).toBe(before);
		expect(second.lines.some((line) => line.includes('already scaffolded'))).toBe(true);
	});

	it('refuses to overwrite a differing existing file', async () => {
		const root = await createCliWorkspace();
		await mkdir(join(root, scaffoldDir, 'src'), { recursive: true });
		await writeFile(join(root, scaffoldDir, 'src', 'manifest.ts'), 'export const mine = 1;\n');

		const { io } = captureIo();
		await expect(runCreate(root, { idInput: 'my-plugin', dryRun: false }, io)).rejects.toThrow(
			PluginCliError
		);
		// The conflicting file is left untouched; validation precedes mutation.
		expect(await readFile(join(root, scaffoldDir, 'src', 'manifest.ts'), 'utf8')).toBe(
			'export const mine = 1;\n'
		);
	});

	it('writes nothing on --dry-run', async () => {
		const root = await createCliWorkspace();
		const { io, lines } = captureIo();
		await runCreate(root, { idInput: 'my-plugin', dryRun: true }, io);
		await expect(readdir(join(root, scaffoldDir))).rejects.toMatchObject({ code: 'ENOENT' });
		expect(lines.some((line) => line.includes('Dry run'))).toBe(true);
	});

	it('rejects an invalid plugin id', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(runCreate(root, { idInput: 'Not Valid', dryRun: false }, io)).rejects.toThrow(
			/not a valid plugin id/
		);
	});

	it('refuses a target directory that escapes the workspace', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(
			runCreate(root, { idInput: 'my-plugin', dir: '../escape', dryRun: false }, io)
		).rejects.toThrow(/outside the workspace/);
	});
});
