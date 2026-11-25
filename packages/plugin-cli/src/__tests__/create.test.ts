import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

	/**
	 * THE TEMPLATE FLAG, THROUGH THE COMMAND — the plumbing between the invocation
	 * the authoring guide prints and the generator its conformance gate drives.
	 * `scaffoldSendProvider.test.ts` owns what the template EMITS and the
	 * conformance gate owns that the emitted bundle WORKS; both call `buildScaffold`
	 * directly, so without these two cases nothing executes `--template` end to end.
	 */
	it('writes the whole send-provider bundle and points at its guide', async () => {
		const root = await createCliWorkspace();
		const { io, lines } = captureIo();
		await runCreate(root, { idInput: 'my-plugin', template: 'send-provider', dryRun: false }, io);

		expect((await readdir(join(root, scaffoldDir, 'src', 'convex'))).sort()).toEqual([
			'domainIdentity.ts',
			'transport.ts',
			'webhook.ts',
		]);
		// The completion hint is template-specific: an author who just scaffolded a
		// provider is sent to the page that documents the contract, not to the
		// generic "declare contributions in src/manifest.ts".
		expect(lines.some((line) => line.includes('/developer/plugin-send-providers'))).toBe(true);
	});

	it('rejects an unknown template before it creates anything', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(
			runCreate(root, { idInput: 'my-plugin', template: 'sendprovider', dryRun: false }, io)
		).rejects.toThrow(PluginCliError);
		// Parsed BEFORE the target directory is touched: a typo must not leave a
		// directory behind for the retry to trip over.
		await expect(readdir(join(root, scaffoldDir))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('refuses the checkout root and a directory that contains it', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		for (const dir of ['.', '..']) {
			await expect(
				runCreate(root, { idInput: 'my-plugin', dir, dryRun: false }, io)
			).rejects.toThrow(/checkout root or contains it/);
		}
	});

	describe('outside the checkout', () => {
		const outsideRoots: string[] = [];
		afterEach(async () => {
			await Promise.all(
				outsideRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
			);
		});

		async function standaloneCheckout(): Promise<{ root: string; dir: string }> {
			const root = await createCliWorkspace();
			await writeFile(
				join(root, 'package.json'),
				JSON.stringify({
					workspaces: {
						packages: ['packages/*'],
						catalog: { '@types/node': '^26.6.6', typescript: '^6.0.3', vitest: '^5.1.0' },
					},
					devDependencies: { oxlint: '^1.93.0' },
				})
			);
			await mkdir(join(root, 'packages', 'plugin-kit'), { recursive: true });
			await writeFile(
				join(root, 'packages', 'plugin-kit', 'package.json'),
				JSON.stringify({ name: '@owlat/plugin-kit', version: '0.6.24' })
			);
			const outside = await mkdtemp(join(tmpdir(), 'owlat-plugin-outside-'));
			outsideRoots.push(outside);
			return { root, dir: join(outside, 'hello-owlat') };
		}

		it('writes a package that installs the kit from npm and reaches into no checkout', async () => {
			const { root, dir } = await standaloneCheckout();
			const { io, lines } = captureIo();
			await runCreate(root, { idInput: 'hello-owlat', dir, dryRun: false }, io);

			const packageJson = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
			expect(packageJson.dependencies).toEqual({ '@owlat/plugin-kit': '^0.6.24' });
			expect(packageJson.devDependencies).toEqual({
				'@types/node': '^26.6.6',
				oxlint: '^1.93.0',
				typescript: '^6.0.3',
				vitest: '^5.1.0',
			});
			expect(packageJson.scripts.lint).toBe('oxlint src');
			for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts', 'README.md']) {
				const content = await readFile(join(dir, file), 'utf8');
				expect(content, file).not.toMatch(/workspace:|catalog:|\.\.\/|packages\/plugin-kit/);
			}
			const readme = await readFile(join(dir, 'README.md'), 'utf8');
			expect(readme).toContain('bun publish --access public');
			expect(readme).toContain('bun add --exact @owlat/plugin-hello-owlat@0.0.0');
			expect(lines.at(-1)).toContain('run `bun install` in it first');
		});

		it('gives the send-provider template the same standalone wiring', async () => {
			const { root, dir } = await standaloneCheckout();
			const { io } = captureIo();
			await runCreate(
				root,
				{ idInput: 'acme-mail', dir, template: 'send-provider', dryRun: false },
				io
			);
			const readme = await readFile(join(dir, 'README.md'), 'utf8');
			expect(readme).not.toContain('oxfmtrc.json');
			expect(readme).toContain('bun publish --access public');
			const packageJson = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
			expect(packageJson.exports['./convex/transport']).toBe('./src/convex/transport.ts');
		});

		it('names what is missing when the checkout has no kit version to pin', async () => {
			const root = await createCliWorkspace();
			const outside = await mkdtemp(join(tmpdir(), 'owlat-plugin-outside-'));
			outsideRoots.push(outside);
			const { io } = captureIo();
			await expect(
				runCreate(
					root,
					{ idInput: 'hello-owlat', dir: join(outside, 'hello-owlat'), dryRun: false },
					io
				)
			).rejects.toThrow(/packages\/plugin-kit\/package\.json/);
			await expect(readdir(outside)).resolves.toEqual([]);
		});
	});
});
