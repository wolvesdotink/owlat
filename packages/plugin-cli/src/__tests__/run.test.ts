import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePluginId } from '@owlat/plugin-kit';
import type { PluginPackageName } from '@owlat/plugin-host';
import { PluginCliError } from '../errors';
import { buildScaffold, SCAFFOLD_TEMPLATES } from '../scaffold';
import { dispatchFinite, KNOWN_COMMANDS, USAGE } from '../run';
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

describe('dispatchFinite', () => {
	it('routes add through to a real config mutation', async () => {
		const root = await createCliWorkspace({
			modules: {
				'alpha-plugin': manifestModule({ id: 'alpha', version: '1.0.0', capabilities: [] }),
			},
		});
		const { io } = captureIo();

		await dispatchFinite('add', ['alpha-plugin'], { workspaceRoot: root, io });

		expect(await readConfigSource(root)).toContain("bundledPluginPackages: ['alpha-plugin'],");
	});

	it('routes codegen and honors its flags', async () => {
		const root = await createCliWorkspace();
		const { io, lines } = captureIo();
		await dispatchFinite('codegen', ['--boundaries-only'], { workspaceRoot: root, io });
		expect(lines.join('\n')).toContain('Plugin package boundaries are valid.');
	});

	it('rejects an unknown command with actionable guidance', async () => {
		const { io } = captureIo();
		await expect(
			dispatchFinite('frobnicate', [], { workspaceRoot: '/workspace', io })
		).rejects.toThrow(PluginCliError);
	});

	it('does not scaffold into a directory named after a swallowed flag', async () => {
		// `create my-plugin --dir --dry-run`: the flag parser must refuse rather
		// than consume `--dry-run` as the `--dir` value and write a real tree into
		// a directory literally named `--dry-run` with the switch silently off.
		const root = await createCliWorkspace();
		const { io } = captureIo();
		await expect(
			dispatchFinite('create', ['my-plugin', '--dir', '--dry-run'], { workspaceRoot: root, io })
		).rejects.toThrow(/requires a value/);
		await expect(readdir(join(root, '--dry-run'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('surfaces a malformed add invocation before any side effect', async () => {
		const root = await createCliWorkspace();
		const before = await readConfigSource(root);
		const { io } = captureIo();
		await expect(dispatchFinite('add', [], { workspaceRoot: root, io })).rejects.toThrow(
			/Missing required package name/
		);
		expect(await readConfigSource(root)).toBe(before);
	});
});

describe('USAGE', () => {
	it('documents every known command', () => {
		for (const command of KNOWN_COMMANDS) expect(USAGE).toContain(command);
	});
});

describe('the command name', () => {
	// The binary is the only thing a developer can run, so every place that tells
	// them what to type has to name it. A spelling with a space reads like a
	// subcommand of the operator wrapper, which has none.
	const invocation = 'bun run owlat-plugins';

	it('is the package binary, and the usage text names it that way', async () => {
		const packageJson = JSON.parse(
			await readFile(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')
		) as { bin: Record<string, string> };
		expect(Object.keys(packageJson.bin)).toEqual(['owlat-plugins']);
		expect(USAGE).toContain(`Usage: ${invocation} <command> [options]`);
		expect(USAGE).not.toMatch(/owlat plugins/);
	});

	it('is the one an unknown command points at', async () => {
		const root = await createCliWorkspace();
		const { io } = captureIo();
		const error = await dispatchFinite('bundle', [], { workspaceRoot: root, io }).catch(
			(cause: unknown) => cause
		);
		expect((error as PluginCliError).details).toContain(`Run "${invocation} --help" for usage.`);
	});

	it.each(SCAFFOLD_TEMPLATES)('is the one the %s README tells its author to run', (template) => {
		const packageName = '@acme/owlat-plugin-hello' as PluginPackageName;
		const readme = buildScaffold(
			'/workspace',
			'/workspace/examples/plugins/hello',
			parsePluginId('hello'),
			packageName,
			template
		).get('README.md');
		expect(readme).toContain(`${invocation} add ${packageName}`);
		expect(readme).not.toMatch(/owlat plugins/);
	});
});
