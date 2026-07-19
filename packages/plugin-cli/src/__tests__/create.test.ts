import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

	it('rolls back files already written when a mid-scaffold write fails', async () => {
		const root = await createCliWorkspace();
		const target = join(root, scaffoldDir);
		await mkdir(join(target, 'src'), { recursive: true });
		// A read-only src/ passes the pre-write inspect (its missing files read as
		// ENOENT, not a hard error) yet makes the first write *into* it — creating
		// src/__tests__/ — fail with EACCES, so the failure lands inside
		// writeScaffold *after* the top-level files (README.md, package.json, …)
		// are already on disk. That is the partial-write the rollback must undo.
		// (Pre-creating src as a *file* instead would trip the earlier inspect
		// guard with ENOTDIR and never reach writeScaffold at all.)
		await chmod(join(target, 'src'), 0o555);

		const { io } = captureIo();
		try {
			await expect(runCreate(root, { idInput: 'my-plugin', dryRun: false }, io)).rejects.toThrow(
				PluginCliError
			);
			// Every file this run wrote is gone; only the pre-existing src/ remains,
			// so a failed run never leaves a half-written package behind.
			expect((await readdir(target)).sort()).toEqual(['src']);
		} finally {
			await chmod(join(target, 'src'), 0o755);
		}
	});

	it('rolls back an outer directory it created when a deeper mkdir fails mid-chain', async () => {
		const root = await createCliWorkspace();
		// A umask stripping every permission bit makes the first (outer) directory
		// this run creates unwritable, so creating the directory *below* it fails
		// EACCES — a non-EEXIST mkdir failure partway up a fresh multi-level chain,
		// the same class as ENOSPC/EDQUOT. The outer directory was created by this
		// run and must be rolled back, not orphaned.
		const previousUmask = process.umask(0o777);
		const { io } = captureIo();
		try {
			await expect(
				runCreate(root, { idInput: 'my-plugin', dir: join('leaked', 'nested'), dryRun: false }, io)
			).rejects.toThrow(PluginCliError);
		} finally {
			process.umask(previousUmask);
		}
		// The outer leaked/ directory this run created before the failing mkdir was
		// removed by rollback (its child was never created).
		await expect(stat(join(root, 'leaked'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('refuses a target directory that escapes the workspace', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(
			runCreate(root, { idInput: 'my-plugin', dir: '../escape', dryRun: false }, io)
		).rejects.toThrow(/outside the workspace/);
	});
});
