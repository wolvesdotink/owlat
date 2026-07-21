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
		expect(text).toContain('owlat plugins codegen');
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
