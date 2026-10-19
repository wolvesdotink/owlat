#!/usr/bin/env bun
/**
 * JS → Rust command-name contract for the desktop app.
 *
 * The desktop bridge (`apps/desktop/src/*.ts`, loaded by the web SPA inside the
 * Tauri webview) calls the Rust shell through `invoke('<command>')`. The Rust
 * side already keeps itself consistent: `src-tauri/src/ipc_commands.rs` lists
 * every app command per window, build.rs turns each into an `allow-<command>`
 * permission, and the Rust tests there check those lists against main.rs's
 * `generate_handler!`, the capability files and the release/dev split (CI runs
 * them with and without `dev-provisioning`). Those tests stay the authority for
 * the Rust half; this gate does not repeat them.
 *
 * What nothing checked was the JS half. A renamed or removed Rust command left
 * its `invoke('old_name')` caller compiling, typechecking and passing its
 * mocked unit tests; the app only failed at runtime, in the one window that hit
 * that code path. This gate reads the three lists from ipc_commands.rs (source
 * level, so the Lint job needs no Rust toolchain) and fails when
 * - an `invoke()` names a command no list registers,
 * - a module that also runs in the compose window calls a main-window-only
 *   command (PROVISIONING_COMMANDS / DEV_PROVISIONING_COMMANDS; the capability
 *   files grant those to `main` alone), or
 * - a call's command name is not a string literal and has no entry in
 *   DYNAMIC_INVOKES naming the commands it can take, or
 * - `invoke` is used in any way other than a direct call (the rule and its
 *   limits are in scripts/desktop-invoke-scan.ts): every binding or reference
 *   that can reach the core `invoke` or the `__TAURI_INTERNALS__` /
 *   `__TAURI__` globals must be called directly; exporting it, destructuring
 *   it from a namespace or global, element access, assignment or passing it as
 *   a value is an "untraceable invoke use", and so is an `import()` of a
 *   non-literal module name anywhere in the scanned code. A scan that finds no
 *   calls at all fails too.
 *
 * Plugin commands (`plugin:<plugin>|<command>`, what the @tauri-apps/plugin-*
 * packages send) are not app commands: the plugin's own ACL authorises them.
 * The gate only checks that some capability file grants that plugin anything,
 * and does not check them against ipc_commands.rs.
 *
 * Run by `bun run lint:desktop-invoke`, and from `ci:lint` / `ci:verify`.
 * Exercised by `scripts/__tests__/check-desktop-invoke-contract.test.ts`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
	CORE_MODULE,
	nonLiteralImports,
	scanFile,
	TAURI_GLOBAL_PATTERN,
	vueScript,
} from './desktop-invoke-scan';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const IPC_COMMANDS_FILE = 'apps/desktop/src-tauri/src/ipc_commands.rs';

/** Where JS that can reach the Tauri IPC lives: the bridge and the web app. */
export const SCAN_DIRS: readonly string[] = ['apps/desktop/src', 'apps/web/app'];

const CAPABILITY_DIRS = [
	'apps/desktop/src-tauri/capabilities',
	'apps/desktop/src-tauri/capabilities-dev',
];

/** `plugin:<plugin>|<command>`: a plugin command, authorised by the plugin's ACL. */
const PLUGIN_COMMAND = /^plugin:([a-z0-9-]+)\|([a-z0-9_-]+)$/;

/**
 * Bridge modules only the main window loads, so they may call the
 * main-window-only commands. `ssh.ts` is the server wizard's transport; the
 * compose window never provisions.
 */
export const MAIN_WINDOW_MODULES: readonly string[] = ['apps/desktop/src/ssh.ts'];

/**
 * `invoke()` calls whose command name is computed: file → the argument's source
 * text → every command it can name. Each name is checked like a literal. Empty
 * today; an entry with no matching call is itself a finding.
 */
export const DYNAMIC_INVOKES: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {};

export interface CommandLists {
	readonly window: readonly string[];
	readonly provisioning: readonly string[];
	readonly devProvisioning: readonly string[];
}

const LIST_NAMES = {
	WINDOW_COMMANDS: 'window',
	PROVISIONING_COMMANDS: 'provisioning',
	DEV_PROVISIONING_COMMANDS: 'devProvisioning',
} as const;

/**
 * The three command lists from ipc_commands.rs. Throws when a list is missing,
 * empty or holds anything but string literals, so a reshaped Rust file breaks
 * the gate loudly instead of shrinking what it checks.
 */
export function parseCommandLists(source: string): CommandLists {
	const lists: Partial<Record<keyof CommandLists, string[]>> = {};
	const declaration = /pub const (\w+): &\[&str\] =\s*&\[([^\]]*)\];/g;
	for (const [, name, body] of source.matchAll(declaration)) {
		const key = LIST_NAMES[name as keyof typeof LIST_NAMES];
		if (!key) continue;
		const items = (body as string)
			.replace(/\/\/[^\n]*/g, '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
		const names = items.map((item) => /^"([a-z0-9_]+)"$/.exec(item)?.[1]);
		if (names.length === 0 || names.some((n) => n === undefined)) {
			throw new Error(`${IPC_COMMANDS_FILE}: ${name} is not a list of command-name literals`);
		}
		lists[key] = names as string[];
	}
	for (const [name, key] of Object.entries(LIST_NAMES)) {
		if (!lists[key]) throw new Error(`${IPC_COMMANDS_FILE}: no \`pub const ${name}\` list`);
	}
	return lists as CommandLists;
}

export interface InvokeContractOptions {
	/** Repository root to scan. Defaults to this repository. */
	readonly root?: string;
	readonly mainWindowModules?: readonly string[];
	readonly dynamicInvokes?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export interface InvokeContractResult {
	/** Every `invoke()` call found, as `file:line command`. */
	readonly calls: readonly string[];
	/** Each violation as `file:line  message`. */
	readonly problems: readonly string[];
}

function isSource(path: string): boolean {
	if (path.includes('/__tests__/') || path.includes('/node_modules/')) return false;
	if (/\.(test|spec)\.ts$/.test(path) || path.endsWith('.d.ts')) return false;
	return path.endsWith('.ts') || path.endsWith('.vue');
}

async function collect(root: string, dir: string, out: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(join(root, dir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const child = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules' && entry.name !== '__tests__')
				await collect(root, child, out);
		} else if (isSource(child)) {
			out.push(child);
		}
	}
}

/**
 * Tauri's core plugins: their permissions are `core:<plugin>:*`, and
 * `core:default` grants each one's default set.
 */
const CORE_PLUGINS = new Set([
	'app',
	'event',
	'image',
	'menu',
	'path',
	'resources',
	'tray',
	'webview',
	'window',
]);

/** Every permission any capability file grants (release and dev). */
async function capabilityPermissions(root: string): Promise<Set<string>> {
	const permissions = new Set<string>();
	for (const dir of CAPABILITY_DIRS) {
		let names: string[];
		try {
			names = await readdir(join(root, dir));
		} catch {
			continue;
		}
		for (const name of names.filter((n) => n.endsWith('.json'))) {
			const json = JSON.parse(await readFile(join(root, dir, name), 'utf8')) as {
				permissions?: (string | { identifier?: string })[];
			};
			for (const entry of json.permissions ?? []) {
				const id = typeof entry === 'string' ? entry : entry.identifier;
				if (id) permissions.add(id);
			}
		}
	}
	return permissions;
}

function pluginGranted(plugin: string, permissions: Set<string>): boolean {
	if (CORE_PLUGINS.has(plugin) && permissions.has('core:default')) return true;
	return [...permissions].some(
		(p) => p.startsWith(`${plugin}:`) || p.startsWith(`core:${plugin}:`)
	);
}

export async function checkDesktopInvokeContract(
	options: InvokeContractOptions = {}
): Promise<InvokeContractResult> {
	const root = options.root ?? REPOSITORY_ROOT;
	const mainWindowModules = new Set(options.mainWindowModules ?? MAIN_WINDOW_MODULES);
	const dynamicInvokes = options.dynamicInvokes ?? DYNAMIC_INVOKES;
	const lists = parseCommandLists(await readFile(join(root, IPC_COMMANDS_FILE), 'utf8'));
	const everyWindow = new Set(lists.window);
	const registered = new Set([...lists.window, ...lists.provisioning, ...lists.devProvisioning]);

	const files: string[] = [];
	for (const dir of SCAN_DIRS) await collect(root, dir, files);
	files.sort();

	const calls: string[] = [];
	const problems: string[] = [];
	const usedFixtures = new Set<string>();
	let callCount = 0;
	let permissions: Set<string> | undefined;
	for (const file of files) {
		const raw = await readFile(join(root, file), 'utf8');
		const namesTheIpc = raw.includes(CORE_MODULE) || TAURI_GLOBAL_PATTERN.test(raw);
		// A non-literal import() could load the module under an assembled name, so
		// it is checked in every file, before the module-name prefilter skips one.
		if (!namesTheIpc && !/\bimport\s*\(/.test(raw)) continue;
		const text = file.endsWith('.vue') ? vueScript(raw) : raw;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const found = namesTheIpc ? scanFile(source) : { calls: [], problems: [] };
		const fileProblems = [
			...nonLiteralImports(source).map((line) => ({
				line,
				message: 'untraceable invoke use: import() of a non-literal module name',
			})),
			...found.problems,
		].sort((a, b) => a.line - b.line);
		for (const problem of fileProblems)
			problems.push(`${file}:${problem.line}  ${problem.message}`);
		callCount += found.calls.length;
		for (const call of found.calls) {
			const at = `${file}:${call.line}`;
			let names: readonly string[];
			if (call.arg && ts.isStringLiteralLike(call.arg)) {
				names = [call.arg.text];
			} else {
				const expression = call.arg?.getText(source) ?? '';
				const fixture = dynamicInvokes[file]?.[expression];
				if (!fixture) {
					problems.push(
						`${at}  invoke(${expression}) has no literal command name; ` +
							'list the commands it can name in DYNAMIC_INVOKES'
					);
					continue;
				}
				usedFixtures.add(`${file}\0${expression}`);
				names = fixture;
			}
			for (const name of names) {
				calls.push(`${at} ${name}`);
				const plugin = PLUGIN_COMMAND.exec(name)?.[1];
				if (plugin) {
					permissions ??= await capabilityPermissions(root);
					if (!pluginGranted(plugin, permissions)) {
						problems.push(`${at}  invoke('${name}'): no capability grants the ${plugin} plugin`);
					}
				} else if (name.startsWith('plugin:')) {
					problems.push(`${at}  invoke('${name}') is not a plugin:<plugin>|<command> name`);
				} else if (!registered.has(name)) {
					problems.push(`${at}  invoke('${name}') is not a command in ${IPC_COMMANDS_FILE}`);
				} else if (!everyWindow.has(name) && !mainWindowModules.has(file)) {
					problems.push(
						`${at}  invoke('${name}') is granted to the main window only, but this module ` +
							'can run in the compose window too (MAIN_WINDOW_MODULES lists the main-only ones)'
					);
				}
			}
		}
	}

	for (const [file, entries] of Object.entries(dynamicInvokes)) {
		for (const expression of Object.keys(entries)) {
			if (!usedFixtures.has(`${file}\0${expression}`)) {
				problems.push(`${file}  DYNAMIC_INVOKES entry \`${expression}\` matches no invoke() call`);
			}
		}
	}
	for (const file of mainWindowModules) {
		if (!files.includes(file)) problems.push(`${file}  MAIN_WINDOW_MODULES names a missing module`);
	}
	if (callCount === 0) {
		problems.push(`no invoke() calls found under ${SCAN_DIRS.join(', ')}; the scan is broken`);
	}
	return { calls, problems };
}

if (import.meta.main) {
	const { calls, problems } = await checkDesktopInvokeContract();
	if (problems.length > 0) {
		console.error('Desktop invoke() calls do not match the Rust command lists:\n');
		for (const problem of problems) console.error(`  - ${problem}`);
		console.error(
			`\nThe commands and their windows are listed in ${IPC_COMMANDS_FILE}; rename the\n` +
				'caller, or register the command there (its Rust tests check main.rs and the\n' +
				'capability files against those lists).'
		);
		process.exit(1);
	}
	console.info(
		`All ${calls.length} desktop invoke() calls name a registered command for their window.`
	);
}
