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
 *   DYNAMIC_INVOKES naming the commands it can take.
 *
 * It fails closed on anything it cannot read: `invoke` passed around as a
 * value, re-exported, or reached through a namespace it cannot follow is a
 * finding, not a skip, and so is a scan that finds no calls at all.
 *
 * Run by `bun run lint:desktop-invoke`, and from `ci:lint` / `ci:verify`.
 * Exercised by `scripts/__tests__/check-desktop-invoke-contract.test.ts`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const IPC_COMMANDS_FILE = 'apps/desktop/src-tauri/src/ipc_commands.rs';

/** Where JS that can reach the Tauri IPC lives: the bridge and the web app. */
export const SCAN_DIRS: readonly string[] = ['apps/desktop/src', 'apps/web/app'];

const CORE_MODULE = '@tauri-apps/api/core';

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
 * A `.vue` file with everything outside its `<script>` blocks blanked, newlines
 * kept, so offsets and line numbers still match the file.
 */
function vueScript(text: string): string {
	const keep = new Uint8Array(text.length);
	for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
		const start = match.index + match[0].indexOf('>') + 1;
		keep.fill(1, start, start + (match[1] as string).length);
	}
	let out = '';
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i] as string;
		out += keep[i] || char === '\n' ? char : ' ';
	}
	return out;
}

function isCoreImport(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		node.expression.kind === ts.SyntaxKind.ImportKeyword &&
		node.arguments.length === 1 &&
		ts.isStringLiteralLike(node.arguments[0] as ts.Expression) &&
		(node.arguments[0] as ts.StringLiteralLike).text === CORE_MODULE
	);
}

/** Skip `await` and parentheses between an expression and what consumes it. */
function consumer(node: ts.Node): ts.Node {
	let current = node;
	while (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) {
		current = current.parent;
	}
	return current;
}

interface FileFindings {
	readonly calls: { line: number; arg: ts.Expression | undefined }[];
	readonly problems: { line: number; message: string }[];
}

/**
 * Every `invoke()` call in one file, and every use of `invoke` this cannot
 * follow. Identifiers are matched by name file-wide (no scope analysis): a
 * shadowing local only ever adds findings, it never hides a call.
 */
function scanFile(source: ts.SourceFile, hasTauriGlobal: boolean): FileFindings {
	const calls: FileFindings['calls'] = [];
	const problems: FileFindings['problems'] = [];
	const line = (node: ts.Node) =>
		source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const invokeNames = new Set<string>();
	const namespaces = new Set<string>();
	const declarations = new Set<ts.Node>();

	const bindPattern = (pattern: ts.BindingName, at: ts.Node) => {
		if (ts.isIdentifier(pattern)) {
			namespaces.add(pattern.text);
			declarations.add(pattern);
		} else if (ts.isObjectBindingPattern(pattern)) {
			for (const element of pattern.elements) {
				const imported = (element.propertyName ?? element.name) as ts.Node;
				if (element.dotDotDotToken) {
					problems.push({ line: line(at), message: `rest binding of ${CORE_MODULE} hides invoke` });
				} else if (ts.isIdentifier(imported) && imported.text === 'invoke') {
					if (ts.isIdentifier(element.name)) {
						invokeNames.add(element.name.text);
						declarations.add(element.name);
					}
				}
			}
		} else {
			problems.push({ line: line(at), message: `unreadable binding of ${CORE_MODULE}` });
		}
	};

	const bind = (node: ts.Node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			if (node.moduleSpecifier.text !== CORE_MODULE || node.importClause?.isTypeOnly) return;
			const bindings = node.importClause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				namespaces.add(bindings.name.text);
				declarations.add(bindings.name);
			} else if (bindings) {
				for (const element of bindings.elements) {
					if ((element.propertyName ?? element.name).text === 'invoke' && !element.isTypeOnly) {
						invokeNames.add(element.name.text);
						declarations.add(element.name);
					}
				}
			}
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
			if ((node.moduleSpecifier as ts.StringLiteral).text !== CORE_MODULE) return;
			const exportsInvoke =
				!node.exportClause ||
				!ts.isNamedExports(node.exportClause) ||
				node.exportClause.elements.some(
					(e) => (e.propertyName ?? e.name).getText(source) === 'invoke'
				);
			if (exportsInvoke)
				problems.push({ line: line(node), message: `re-exports invoke from ${CORE_MODULE}` });
		} else if (isCoreImport(node)) {
			const outer = consumer(node);
			const parent = outer.parent;
			if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
				bindPattern(parent.name, node);
			} else if (
				ts.isPropertyAccessExpression(parent) &&
				parent.expression === outer &&
				parent.name.text === 'invoke'
			) {
				record(parent);
			} else {
				problems.push({ line: line(node), message: `cannot follow this import('${CORE_MODULE}')` });
			}
		}
		ts.forEachChild(node, bind);
	};

	/** `callee` is an expression that evaluates to `invoke`. */
	const record = (callee: ts.Node) => {
		const parent = callee.parent;
		if (ts.isCallExpression(parent) && parent.expression === callee) {
			calls.push({ line: line(parent), arg: parent.arguments[0] });
		} else {
			problems.push({
				line: line(callee),
				message: 'invoke used as a value; call it with a command name',
			});
		}
	};

	const use = (node: ts.Node) => {
		if (ts.isIdentifier(node) && !declarations.has(node)) {
			const parent = node.parent;
			const isPropertyName =
				(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
				(ts.isPropertyAssignment(parent) && parent.name === node) ||
				ts.isImportSpecifier(parent) ||
				ts.isExportSpecifier(parent) ||
				ts.isBindingElement(parent) ||
				ts.isTypeQueryNode(parent);
			if (invokeNames.has(node.text) && !isPropertyName) {
				record(node);
			} else if (namespaces.has(node.text) && !isPropertyName) {
				if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
					if (parent.name.text === 'invoke') record(parent);
				} else if (!ts.isTypeQueryNode(parent) && !ts.isQualifiedName(parent)) {
					problems.push({ line: line(node), message: `${CORE_MODULE} namespace used as a value` });
				}
			}
		} else if (
			hasTauriGlobal &&
			ts.isPropertyAccessExpression(node) &&
			node.name.text === 'invoke' &&
			/__TAURI(?:_INTERNALS)?__/.test(node.expression.getText(source))
		) {
			record(node);
		}
		ts.forEachChild(node, use);
	};

	bind(source);
	use(source);
	// The two walks each find calls; report them in source order.
	calls.sort((a, b) => a.line - b.line);
	problems.sort((a, b) => a.line - b.line);
	return { calls, problems };
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
	for (const file of files) {
		const raw = await readFile(join(root, file), 'utf8');
		const hasTauriGlobal = /__TAURI(?:_INTERNALS)?__/.test(raw);
		if (!raw.includes(CORE_MODULE) && !hasTauriGlobal) continue;
		const text = file.endsWith('.vue') ? vueScript(raw) : raw;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const found = scanFile(source, hasTauriGlobal);
		for (const problem of found.problems)
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
				if (!registered.has(name)) {
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
