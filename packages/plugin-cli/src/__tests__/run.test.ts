import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginCliError } from '../errors';
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
