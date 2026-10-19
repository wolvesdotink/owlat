/**
 * The desktop invoke-name contract gate's own tests.
 *
 * Each case builds a throwaway repository with an ipc_commands.rs and a few
 * bridge modules, carrying one shape the gate must catch or must let through.
 * The real tree is checked too, and so is the real tree with one Rust command
 * renamed: that is the regression the gate exists for.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	checkDesktopInvokeContract,
	IPC_COMMANDS_FILE,
	parseCommandLists,
} from '../check-desktop-invoke-contract';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const created: string[] = [];

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const IPC = `
pub const WINDOW_COMMANDS: &[&str] = &[
    "zoom_level",
    // a comment between entries
    "open_compose",
];

pub const PROVISIONING_COMMANDS: &[&str] = &["ssh_connect"];

pub const DEV_PROVISIONING_COMMANDS: &[&str] =
    &["local_docker_build"];
`;

async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'owlat-invoke-contract-'));
	created.push(root);
	for (const [path, contents] of Object.entries({ [IPC_COMMANDS_FILE]: IPC, ...files })) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), contents, 'utf8');
	}
	return root;
}

const SSH = 'apps/desktop/src/ssh.ts';
const WINDOW = 'apps/desktop/src/window.ts';
const IMPORT = "import { invoke } from '@tauri-apps/api/core';\n";

async function check(files: Readonly<Record<string, string>>, options = {}) {
	return checkDesktopInvokeContract({
		root: await fixture(files),
		mainWindowModules: SSH in files ? [SSH] : [],
		...options,
	});
}

describe('parseCommandLists', () => {
	it('reads the three lists, comments and line breaks included', () => {
		expect(parseCommandLists(IPC)).toEqual({
			window: ['zoom_level', 'open_compose'],
			provisioning: ['ssh_connect'],
			devProvisioning: ['local_docker_build'],
		});
	});

	it('throws on a missing list or one that is not all literals', () => {
		expect(() => parseCommandLists(IPC.replace('DEV_PROVISIONING_COMMANDS', 'OTHER'))).toThrow(
			/DEV_PROVISIONING_COMMANDS/
		);
		expect(() => parseCommandLists(IPC.replace('"ssh_connect"', 'SSH_CONNECT'))).toThrow(
			/PROVISIONING_COMMANDS is not a list/
		);
	});

	it('reads the real ipc_commands.rs', async () => {
		const lists = parseCommandLists(
			await readFile(join(REPOSITORY_ROOT, IPC_COMMANDS_FILE), 'utf8')
		);
		expect(lists.window).toContain('zoom_level');
		expect(lists.provisioning).toContain('ssh_connect');
		expect(lists.devProvisioning).toContain('local_docker_build');
	});
});

describe('the desktop invoke contract gate', () => {
	it('passes literal calls to registered commands from the right windows', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}export const z = () => invoke<number>('zoom_level');\n`,
			[SSH]: `${IMPORT}export const c = () => invoke('ssh_connect');\nexport const b = () => invoke(\`local_docker_build\`);\n`,
		});
		expect(result.problems).toEqual([]);
		expect(result.calls).toEqual([
			`${SSH}:2 ssh_connect`,
			`${SSH}:3 local_docker_build`,
			`${WINDOW}:2 zoom_level`,
		]);
	});

	it('fails on a command name Rust does not register', async () => {
		const result = await check({ [WINDOW]: `${IMPORT}invoke('zoom_levels');\n` });
		expect(result.problems).toEqual([
			`${WINDOW}:2  invoke('zoom_levels') is not a command in ${IPC_COMMANDS_FILE}`,
		]);
	});

	it('fails when a module the compose window loads calls a main-only command', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\ninvoke('ssh_connect');\ninvoke('local_docker_build');\n`,
		});
		expect(result.problems).toHaveLength(2);
		expect(result.problems[0]).toContain(
			`${WINDOW}:3  invoke('ssh_connect') is granted to the main window only`
		);
		expect(result.problems[1]).toContain(`${WINDOW}:4  invoke('local_docker_build')`);
	});

	it('follows aliases, namespaces, dynamic imports and the Tauri global', async () => {
		const result = await check({
			'apps/desktop/src/a.ts':
				"import { invoke as call } from '@tauri-apps/api/core';\ncall('nope_a');\n",
			'apps/desktop/src/b.ts':
				"import * as core from '@tauri-apps/api/core';\ncore.invoke('nope_b');\n",
			'apps/web/app/c.ts':
				"export async function f() {\n  const { invoke } = await import('@tauri-apps/api/core');\n  await invoke('nope_c');\n  const core = await import('@tauri-apps/api/core');\n  await core.invoke('nope_d');\n  await (await import('@tauri-apps/api/core')).invoke('nope_e');\n}\n",
			'apps/web/app/d.ts': "window.__TAURI_INTERNALS__.invoke('nope_f');\n",
			'apps/web/app/components/E.vue':
				"<template><div /></template>\n<script setup lang=\"ts\">\nimport { invoke } from '@tauri-apps/api/core';\ninvoke('nope_g');\n</script>\n",
		});
		expect(result.problems.map((p) => p.split('  ')[0])).toEqual([
			'apps/desktop/src/a.ts:2',
			'apps/desktop/src/b.ts:2',
			'apps/web/app/c.ts:3',
			'apps/web/app/c.ts:5',
			'apps/web/app/c.ts:6',
			'apps/web/app/components/E.vue:4',
			'apps/web/app/d.ts:1',
		]);
		expect(result.problems.every((p) => p.includes('is not a command'))).toBe(true);
	});

	it('needs a fixture for a computed command name, and the fixture is checked', async () => {
		const files = {
			[WINDOW]: `${IMPORT}export const run = (name: string) => invoke(name);\n`,
		};
		const bare = await check(files);
		expect(bare.problems).toEqual([
			`${WINDOW}:2  invoke(name) has no literal command name; list the commands it can name in DYNAMIC_INVOKES`,
		]);

		const covered = await check(files, {
			dynamicInvokes: { [WINDOW]: { name: ['zoom_level', 'open_compose'] } },
		});
		expect(covered.problems).toEqual([]);
		expect(covered.calls).toEqual([`${WINDOW}:2 zoom_level`, `${WINDOW}:2 open_compose`]);

		const wrong = await check(files, { dynamicInvokes: { [WINDOW]: { name: ['gone'] } } });
		expect(wrong.problems).toEqual([
			`${WINDOW}:2  invoke('gone') is not a command in ${IPC_COMMANDS_FILE}`,
		]);

		const stale = await check(
			{ [WINDOW]: `${IMPORT}invoke('zoom_level');\n` },
			{ dynamicInvokes: { [WINDOW]: { name: ['zoom_level'] } } }
		);
		expect(stale.problems).toEqual([
			`${WINDOW}  DYNAMIC_INVOKES entry \`name\` matches no invoke() call`,
		]);
	});

	it('fails closed on uses of invoke it cannot follow', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}export const bridge = { invoke };\nexport const alias = invoke;\ninvoke('zoom_level');\n`,
			'apps/desktop/src/reexport.ts': "export { invoke } from '@tauri-apps/api/core';\n",
			'apps/desktop/src/star.ts': "export * from '@tauri-apps/api/core';\n",
			'apps/web/app/promise.ts':
				"import('@tauri-apps/api/core').then((m) => m.invoke('zoom_level'));\n",
		});
		expect(result.problems).toEqual([
			'apps/desktop/src/reexport.ts:1  re-exports invoke from @tauri-apps/api/core',
			'apps/desktop/src/star.ts:1  re-exports invoke from @tauri-apps/api/core',
			`${WINDOW}:2  invoke used as a value; call it with a command name`,
			`${WINDOW}:3  invoke used as a value; call it with a command name`,
			"apps/web/app/promise.ts:1  cannot follow this import('@tauri-apps/api/core')",
		]);
	});

	it('ignores tests, type-only uses and non-invoke imports', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}import { Channel } from '@tauri-apps/api/core';\ntype Invoke = typeof invoke;\nexport const c = new Channel();\ninvoke('zoom_level');\n`,
			'apps/desktop/src/__tests__/window.test.ts': `${IMPORT}invoke('not_real');\n`,
			'apps/web/app/x.test.ts': `${IMPORT}invoke('not_real');\n`,
		});
		expect(result.problems).toEqual([]);
		expect(result.calls).toEqual([`${WINDOW}:5 zoom_level`]);
	});

	it('fails when it finds no calls at all, or a main-window module is gone', async () => {
		const result = await check(
			{ 'apps/desktop/src/other.ts': 'export const x = 1;\n' },
			{ mainWindowModules: [SSH] }
		);
		expect(result.problems).toEqual([
			`${SSH}  MAIN_WINDOW_MODULES names a missing module`,
			'no invoke() calls found under apps/desktop/src, apps/web/app; the scan is broken',
		]);
	});

	it('passes on this repository', async () => {
		const result = await checkDesktopInvokeContract();
		expect(result.problems).toEqual([]);
		expect(result.calls.length).toBeGreaterThan(20);
	});

	it('fails on this repository once a Rust command is renamed', async () => {
		const root = await mkdtemp(join(tmpdir(), 'owlat-invoke-contract-real-'));
		created.push(root);
		await cp(join(REPOSITORY_ROOT, 'apps/desktop/src'), join(root, 'apps/desktop/src'), {
			recursive: true,
		});
		const ipc = await readFile(join(REPOSITORY_ROOT, IPC_COMMANDS_FILE), 'utf8');
		await mkdir(dirname(join(root, IPC_COMMANDS_FILE)), { recursive: true });
		await writeFile(join(root, IPC_COMMANDS_FILE), ipc.replace('"zoom_level"', '"zoom_factor"'));

		const result = await checkDesktopInvokeContract({ root });
		expect(result.problems).toHaveLength(1);
		expect(result.problems[0]).toMatch(
			/^apps\/desktop\/src\/window\.ts:\d+ {2}invoke\('zoom_level'\) is not a command/
		);
	});
});
