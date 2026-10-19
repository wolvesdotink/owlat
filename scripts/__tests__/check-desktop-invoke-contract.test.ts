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
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';
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

	it('reports every use of invoke other than a direct call as untraceable', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}export const bridge = { invoke };\nexport const alias = invoke;\ninvoke('zoom_level');\nexport { invoke };\nexport { invoke as call };\n`,
			'apps/desktop/src/reexport.ts': "export { invoke } from '@tauri-apps/api/core';\n",
			'apps/desktop/src/star.ts': "export * from '@tauri-apps/api/core';\n",
			'apps/desktop/src/default.ts': "import core from '@tauri-apps/api/core';\n",
			'apps/desktop/src/ns.ts':
				"import * as core from '@tauri-apps/api/core';\nconst { invoke } = core;\ncore['invoke']('zoom_level');\nexport const n = core;\nconst c = core.Channel;\n",
			'apps/web/app/promise.ts':
				"import('@tauri-apps/api/core').then((m) => m.invoke('zoom_level'));\n",
			'apps/web/app/global.ts':
				"const { invoke } = window.__TAURI_INTERNALS__;\nwindow.__TAURI_INTERNALS__['invoke']('zoom_level');\nconst t = window.__TAURI__;\nconst i = (globalThis as any).__TAURI_INTERNALS__.invoke;\nexport const ok = typeof window.__TAURI__;\n",
		});
		const untraceable = (at: string, what: string) => `${at}  untraceable invoke use: ${what}`;
		expect(result.problems).toEqual([
			untraceable('apps/desktop/src/default.ts:1', 'default import of @tauri-apps/api/core'),
			untraceable(
				'apps/desktop/src/ns.ts:2',
				'the @tauri-apps/api/core namespace core used as a value'
			),
			untraceable(
				'apps/desktop/src/ns.ts:3',
				'the @tauri-apps/api/core namespace core used as a value'
			),
			untraceable(
				'apps/desktop/src/ns.ts:4',
				'the @tauri-apps/api/core namespace core used as a value'
			),
			untraceable('apps/desktop/src/reexport.ts:1', 're-export from @tauri-apps/api/core'),
			untraceable('apps/desktop/src/star.ts:1', 're-export from @tauri-apps/api/core'),
			untraceable(`${WINDOW}:2`, 'invoke (invoke) is not called directly'),
			untraceable(`${WINDOW}:3`, 'invoke (invoke) is not called directly'),
			untraceable(`${WINDOW}:5`, 'invoke (invoke) is not called directly'),
			untraceable(`${WINDOW}:6`, 'invoke (invoke) is not called directly'),
			untraceable(
				'apps/web/app/global.ts:1',
				'__TAURI_INTERNALS__ used other than as __TAURI_INTERNALS__.invoke(...)'
			),
			untraceable(
				'apps/web/app/global.ts:2',
				'__TAURI_INTERNALS__ used other than as __TAURI_INTERNALS__.invoke(...)'
			),
			untraceable('apps/web/app/global.ts:3', '__TAURI__ used other than as __TAURI__.invoke(...)'),
			untraceable('apps/web/app/global.ts:4', '__TAURI_INTERNALS__.invoke is not called directly'),
			untraceable('apps/web/app/global.ts:5', '__TAURI__ used other than as __TAURI__.invoke(...)'),
			untraceable(
				'apps/web/app/promise.ts:1',
				"import('@tauri-apps/api/core') consumed some other way"
			),
		]);
	});

	it('reports exported import bindings, so another module cannot call them unseen', async () => {
		const result = await check({
			'apps/desktop/src/a.ts':
				"export const { invoke: call } = await import('@tauri-apps/api/core');\n",
			'apps/desktop/src/b.ts': "export const core = await import('@tauri-apps/api/core');\n",
			'apps/desktop/src/c.ts':
				"import * as core from '@tauri-apps/api/core';\nexport default core;\n",
			'apps/desktop/src/d.ts': `${IMPORT}export default invoke;\n`,
			'apps/desktop/src/user.ts': "import { call } from './a';\ncall('removed_command');\n",
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
		});
		const untraceable = (at: string, what: string) => `${at}  untraceable invoke use: ${what}`;
		expect(result.problems).toEqual([
			untraceable('apps/desktop/src/a.ts:1', "exported binding of import('@tauri-apps/api/core')"),
			untraceable('apps/desktop/src/b.ts:1', "exported binding of import('@tauri-apps/api/core')"),
			untraceable(
				'apps/desktop/src/c.ts:2',
				'the @tauri-apps/api/core namespace core used as a value'
			),
			untraceable('apps/desktop/src/d.ts:2', 'invoke (invoke) is not called directly'),
		]);
	});

	it('reports the module name anywhere but an import, export or import()', async () => {
		const named = '@tauri-apps/api/core named outside an import declaration or import()';
		const result = await check({
			'apps/desktop/src/a.ts':
				"import core = require('@tauri-apps/api/core');\ncore.invoke('zoom_level');\n",
			'apps/desktop/src/b.ts':
				"const name = '@tauri-apps/api/core';\nexport const load = () => import(name);\nconst r = require('@tauri-apps/api/core');\n",
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
			'apps/desktop/src/c.ts':
				"export type Core = typeof import('@tauri-apps/api/core');\nexport { Channel } from '@tauri-apps/api/core';\n",
		});
		expect(result.problems).toEqual([
			`apps/desktop/src/a.ts:1  untraceable invoke use: ${named}`,
			`apps/desktop/src/b.ts:1  untraceable invoke use: ${named}`,
			'apps/desktop/src/b.ts:2  untraceable invoke use: import() of a non-literal module name',
			`apps/desktop/src/b.ts:3  untraceable invoke use: ${named}`,
		]);
	});

	it('rejects an import() of any non-literal module name, in every scanned file', async () => {
		const nonLiteral = 'untraceable invoke use: import() of a non-literal module name';
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
			'apps/desktop/src/assembled.ts':
				"const mod = '@tauri-apps/api/' + 'core';\nconst { invoke } = await import(mod);\ninvoke('removed_command');\n",
			'apps/web/app/lazy.ts':
				"export const a = (x: string) => import(`./locales/${x}.js`);\nexport const b = () => import(`./fixed.js`);\nexport const c = () => import('./plain.js');\n",
		});
		expect(result.problems).toEqual([
			`apps/desktop/src/assembled.ts:2  ${nonLiteral}`,
			`apps/web/app/lazy.ts:1  ${nonLiteral}`,
		]);
	});

	it('compares names by value, so quoted specifiers cannot slip a re-export past it', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
			'apps/desktop/src/a.ts': "export { 'invoke' as call } from '@tauri-apps/api/core';\n",
			'apps/desktop/src/b.ts': "import { call } from './a';\ncall('removed_command');\n",
			'apps/desktop/src/c.ts':
				"const { 'invoke': run } = await import('@tauri-apps/api/core');\nrun('nope_c');\n",
		});
		expect(result.problems).toEqual([
			'apps/desktop/src/a.ts:1  untraceable invoke use: re-export from @tauri-apps/api/core',
			`apps/desktop/src/c.ts:2  invoke('nope_c') is not a command in ${IPC_COMMANDS_FILE}`,
		]);
	});

	it('lets type-only re-exports through, whole-statement or per specifier', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
			'apps/desktop/src/types.ts':
				"export type { invoke } from '@tauri-apps/api/core';\nexport { type invoke as Invoke, Channel } from '@tauri-apps/api/core';\n",
		});
		expect(result.problems).toEqual([]);
	});

	it('names a dynamic import bound in an unsupported place for what it is', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
			'apps/desktop/src/loop.ts':
				"for (const core = await import('@tauri-apps/api/core'); false; ) core.invoke('zoom_level');\n",
		});
		expect(result.problems).toEqual([
			"apps/desktop/src/loop.ts:1  untraceable invoke use: import('@tauri-apps/api/core') bound outside a plain variable statement",
		]);
	});

	it('reads the AST, so comments and escapes change nothing', async () => {
		const nonLiteral = 'untraceable invoke use: import() of a non-literal module name';
		const notCommand = (at: string, name: string) =>
			`${at}  invoke('${name}') is not a command in ${IPC_COMMANDS_FILE}`;
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\n`,
			'apps/desktop/src/block.ts': 'const mod = "x";\nexport const a = () => import/* c */(mod);\n',
			'apps/desktop/src/line.ts': 'const mod = "x";\nexport const a = () => import // c\n(mod);\n',
			'apps/desktop/src/static.ts':
				"import { invoke } from '@tauri-apps/api/\\u0063ore';\ninvoke('nope_static');\n",
			'apps/desktop/src/dynamic.ts':
				"const { invoke } = await import('@tauri-apps/api/\\u0063ore');\ninvoke('nope_dynamic');\n",
			'apps/desktop/src/reexport.ts': "export { invoke } from '@tauri-apps/api/\\u0063ore';\n",
			'apps/web/app/key.ts':
				"window['\\u005f_TAURI_INTERNALS__'].invoke('nope_key');\nexport const t = window['\\u005f_TAURI__'];\nwindow.\\u005f_TAURI_INTERNALS__.invoke('nope_ident');\n",
			'apps/web/app/strings.ts':
				"export const a = Reflect.get(window, '__TAURI_INTERNALS__');\nconst { __TAURI__: t } = window as any;\nconst { '__TAURI_INTERNALS__': u } = window as any;\nexport const inApp = '__TAURI__' in window;\n",
		});
		const untraceable = (at: string, what: string) => `${at}  untraceable invoke use: ${what}`;
		expect(result.problems).toEqual([
			`apps/desktop/src/block.ts:2  ${nonLiteral}`,
			notCommand('apps/desktop/src/dynamic.ts:2', 'nope_dynamic'),
			`apps/desktop/src/line.ts:2  ${nonLiteral}`,
			untraceable('apps/desktop/src/reexport.ts:1', 're-export from @tauri-apps/api/core'),
			notCommand('apps/desktop/src/static.ts:2', 'nope_static'),
			untraceable('apps/web/app/key.ts:2', '__TAURI__ used other than as __TAURI__.invoke(...)'),
			notCommand('apps/web/app/key.ts:1', 'nope_key'),
			notCommand('apps/web/app/key.ts:3', 'nope_ident'),
			untraceable('apps/web/app/strings.ts:1', '__TAURI_INTERNALS__ named as a string value'),
			untraceable('apps/web/app/strings.ts:2', '__TAURI__ destructured out of an object'),
			untraceable('apps/web/app/strings.ts:3', '__TAURI_INTERNALS__ named as a string value'),
		]);
	});

	it('lets type-only local exports through', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}invoke('zoom_level');\nexport type { invoke };\nexport { type invoke as Invoke };\n`,
		});
		expect(result.problems).toEqual([]);
	});

	it('accepts the direct global calls and checks their names', async () => {
		const result = await check({
			'apps/web/app/global.ts':
				"window['__TAURI_INTERNALS__'].invoke('nope_a');\nwindow.__TAURI__.core.invoke('zoom_level');\nexport const inApp = '__TAURI_INTERNALS__' in window;\n",
		});
		expect(result.problems).toEqual([
			`apps/web/app/global.ts:1  invoke('nope_a') is not a command in ${IPC_COMMANDS_FILE}`,
		]);
		expect(result.calls).toEqual([
			'apps/web/app/global.ts:1 nope_a',
			'apps/web/app/global.ts:2 zoom_level',
		]);
	});

	it('leaves plugin commands to the plugin ACL, but needs the plugin granted', async () => {
		const capability = JSON.stringify({
			windows: ['main'],
			permissions: ['notification:default', 'core:default'],
		});
		const result = await check({
			'apps/desktop/src-tauri/capabilities/default.json': capability,
			[WINDOW]: `${IMPORT}invoke('plugin:notification|is_permission_granted');\ninvoke('plugin:window|set_title');\ninvoke('plugin:store|load');\ninvoke('plugin:notification');\n`,
		});
		expect(result.problems).toEqual([
			`${WINDOW}:4  invoke('plugin:store|load'): no capability grants the store plugin`,
			`${WINDOW}:5  invoke('plugin:notification') is not a plugin:<plugin>|<command> name`,
		]);
	});

	it('passes a plugin command granted by the real capability files', async () => {
		const root = await fixture({
			[WINDOW]: `${IMPORT}invoke('plugin:notification|is_permission_granted');\n`,
		});
		await cp(
			join(REPOSITORY_ROOT, 'apps/desktop/src-tauri/capabilities'),
			join(root, 'apps/desktop/src-tauri/capabilities'),
			{ recursive: true }
		);
		const result = await checkDesktopInvokeContract({ root, mainWindowModules: [] });
		expect(result.problems).toEqual([]);
		expect(result.calls).toEqual([`${WINDOW}:2 plugin:notification|is_permission_granted`]);
	});

	it('ignores tests, type-only uses and non-invoke imports', async () => {
		const result = await check({
			[WINDOW]: `${IMPORT}import { Channel } from '@tauri-apps/api/core';\ntype Invoke = typeof invoke;\nexport const c = new Channel();\ninvoke('zoom_level');\n`,
			'apps/desktop/src/types.ts':
				"import type { invoke } from '@tauri-apps/api/core';\ninterface Window { __TAURI_INTERNALS__: unknown }\nexport type T = typeof invoke;\n",
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

	// Parses every scanned file of the real tree (~1.3s alone, several times that
	// under a loaded lint:script-tests run), so it takes the shared gate budget
	// rather than vitest's 5s default (vitest.timeouts.ts). The other cases scan
	// a few fixture files.
	it(
		'passes on this repository',
		async () => {
			const result = await checkDesktopInvokeContract();
			expect(result.problems).toEqual([]);
			expect(result.calls.length).toBeGreaterThan(20);
		},
		PARALLEL_GATE_TIMEOUT_MS
	);

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
