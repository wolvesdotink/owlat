import { afterEach, describe, expect, it } from 'vitest';
import { runMutation } from '../commands/mutate';
import { PluginCliError } from '../errors';
import {
	captureIo,
	cleanupCliWorkspaces,
	createCliWorkspace,
	manifestModule,
	readConfigSource,
} from './fixtures';

afterEach(async () => {
	await cleanupCliWorkspaces();
});

const alpha = manifestModule({ id: 'alpha', version: '1.0.0', capabilities: ['mail:read'] });
const beta = manifestModule({
	id: 'beta',
	version: '1.0.0',
	capabilities: ['llm:invoke'],
	flag: { default: false },
	llmBudget: { dailyUsd: 1 },
});

describe('add', () => {
	it('validates, writes the canonical config, and reports the capability diff', async () => {
		const root = await createCliWorkspace({ modules: { 'alpha-plugin': alpha } });
		const { io, lines } = captureIo();

		await runMutation('add', root, { packageInput: 'alpha-plugin', dryRun: false }, io);

		expect(await readConfigSource(root)).toContain("bundledPluginPackages: ['alpha-plugin'],");
		const text = lines.join('\n');
		expect(text).toContain('+ alpha-plugin (alpha)');
		expect(text).toContain('gained: mail:read');
		expect(text).toContain('Added alpha-plugin');
		expect(text).toContain('Run `bun run plugins:codegen` to regenerate the bundled composition.');
	});

	it('is idempotent for an already-listed package', async () => {
		const root = await createCliWorkspace({
			configPackages: ['alpha-plugin'],
			modules: { 'alpha-plugin': alpha },
		});
		const before = await readConfigSource(root);
		const { io, lines } = captureIo();

		await runMutation('add', root, { packageInput: 'alpha-plugin', dryRun: false }, io);

		expect(await readConfigSource(root)).toBe(before);
		expect(lines.join('\n')).toContain('already listed');
	});

	it('previews the diff without writing on --dry-run', async () => {
		const root = await createCliWorkspace({ modules: { 'beta-plugin': beta } });
		const before = await readConfigSource(root);
		const { io, lines } = captureIo();

		await runMutation('add', root, { packageInput: 'beta-plugin', dryRun: true }, io);

		expect(await readConfigSource(root)).toBe(before);
		const text = lines.join('\n');
		expect(text).toContain('gained: llm:invoke');
		expect(text).toContain('Dry run: plugins.config.ts was not modified.');
		expect(text).toContain("bundledPluginPackages: ['beta-plugin'],");
	});

	it('rejects an uninstalled package before mutating anything', async () => {
		const root = await createCliWorkspace();
		const before = await readConfigSource(root);
		const { io } = captureIo();

		await expect(
			runMutation('add', root, { packageInput: 'ghost-plugin', dryRun: false }, io)
		).rejects.toThrow(PluginCliError);
		expect(await readConfigSource(root)).toBe(before);
	});

	it('rejects a package whose manifest is invalid before mutating anything', async () => {
		const root = await createCliWorkspace({
			modules: { 'bad-plugin': manifestModule({ id: 'Bad Id', version: 'nope', capabilities: 5 }) },
		});
		const before = await readConfigSource(root);
		const { io } = captureIo();

		await expect(
			runMutation('add', root, { packageInput: 'bad-plugin', dryRun: false }, io)
		).rejects.toThrow(PluginCliError);
		expect(await readConfigSource(root)).toBe(before);
	});

	it('refuses a package from this workspace and lists the steps that bundle it', async () => {
		const root = await createCliWorkspace({
			workspaceMembers: {
				'examples/plugins/hello-owlat': {
					name: '@acme/owlat-plugin-hello-owlat',
					version: '0.0.0',
					private: true,
				},
			},
		});
		const before = await readConfigSource(root);
		const { io } = captureIo();

		const error = await runMutation(
			'add',
			root,
			{ packageInput: '@acme/owlat-plugin-hello-owlat', dryRun: false },
			io
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(PluginCliError);
		expect((error as PluginCliError).message).toBe(
			'@acme/owlat-plugin-hello-owlat is the workspace package in examples/plugins/hello-owlat. A bundled plugin has to be installed from a package registry.'
		);
		expect((error as PluginCliError).details).toEqual([
			'From the checkout root, publish it, take the folder out of the checkout and install the published version:',
			'  cd examples/plugins/hello-owlat',
			'  npm pkg delete private',
			'  bun publish --access public',
			'  cd -',
			'  mv examples/plugins/hello-owlat ../hello-owlat',
			'  bun add --exact @acme/owlat-plugin-hello-owlat@0.0.0',
			'  bun run owlat-plugins add @acme/owlat-plugin-hello-owlat',
			'The folder has to leave the checkout because Bun links a workspace folder in place of the published package of the same name.',
			'Building a Plugin, step 6, explains each step.',
		]);
		expect(await readConfigSource(root)).toBe(before);
	});

	it('asks for a scope of your own before publishing a package named under @owlat', async () => {
		const root = await createCliWorkspace({
			workspaceMembers: {
				'examples/plugins/hello-owlat': { name: '@owlat/plugin-hello-owlat', version: '0.0.0' },
			},
		});
		const { io } = captureIo();

		const error = (await runMutation(
			'add',
			root,
			{ packageInput: '@owlat/plugin-hello-owlat', dryRun: false },
			io
		).catch((cause: unknown) => cause)) as PluginCliError;

		expect(error.details.slice(0, 4)).toEqual([
			'From the checkout root, publish it, take the folder out of the checkout and install the published version:',
			'  cd examples/plugins/hello-owlat',
			'  npm pkg set name=@your-scope/plugin-hello-owlat',
			'  bun publish --access public',
		]);
		expect(error.details).toContain('  bun add --exact @your-scope/plugin-hello-owlat@0.0.0');
		expect(error.details).toContain(
			'The @owlat scope belongs to the Owlat project: replace @your-scope with an npm scope you can publish to.'
		);
	});

	it('quotes a folder name the shell would split', async () => {
		const root = await createCliWorkspace({
			workspaceMembers: {
				'examples/plugins/my plugin': { name: '@acme/my-plugin', version: '0.0.0', private: true },
			},
		});
		const { io } = captureIo();

		const error = (await runMutation(
			'add',
			root,
			{ packageInput: '@acme/my-plugin', dryRun: false },
			io
		).catch((cause: unknown) => cause)) as PluginCliError;

		expect(error.details).toContain("  cd 'examples/plugins/my plugin'");
		expect(error.details).toContain("  mv 'examples/plugins/my plugin' '../my plugin'");
	});

	it('rejects an invalid package-name argument', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(
			runMutation('add', root, { packageInput: 'NotValid', dryRun: false }, io)
		).rejects.toThrow(/not a valid bundled plugin package name/);
	});
});

describe('remove', () => {
	it('drops a listed package and reports the removed capabilities', async () => {
		const root = await createCliWorkspace({
			configPackages: ['alpha-plugin'],
			modules: { 'alpha-plugin': alpha },
		});
		const { io, lines } = captureIo();

		await runMutation('remove', root, { packageInput: 'alpha-plugin', dryRun: false }, io);

		expect(await readConfigSource(root)).toContain('bundledPluginPackages: [],');
		const text = lines.join('\n');
		expect(text).toContain('- alpha-plugin (alpha)');
		expect(text).toContain('dropped: mail:read');
		expect(text).toContain('Removed alpha-plugin');
	});

	it('is a no-op for an absent package', async () => {
		const root = await createCliWorkspace();
		const before = await readConfigSource(root);
		const { io, lines } = captureIo();

		await runMutation('remove', root, { packageInput: 'ghost-plugin', dryRun: false }, io);

		expect(await readConfigSource(root)).toBe(before);
		expect(lines.join('\n')).toContain('not listed');
	});

	it('still removes a package whose current manifest no longer loads', async () => {
		const root = await createCliWorkspace({
			configPackages: ['broken-plugin'],
			modules: { 'broken-plugin': 'export default { totally: "invalid" };\n' },
		});
		const { io, lines } = captureIo();

		await runMutation('remove', root, { packageInput: 'broken-plugin', dryRun: false }, io);

		expect(await readConfigSource(root)).toContain('bundledPluginPackages: [],');
		expect(lines.join('\n')).toContain('Could not analyze the current bundled set');
	});
});
