import { readFile, readdir, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Metafile, type Plugin } from 'esbuild';

/**
 * Full-function-graph Convex bundle smoke.
 *
 * `convex deploy` bundles every non-test module under `apps/api/convex/`:
 * files whose first statement is the `'use node'` directive go to the Node
 * runtime, everything else is bundled for the default isolate runtime with
 * esbuild platform `browser` (same setup as `convexBundleSmoke.ts`), where
 * `node:*` imports do not resolve. This script replays that split locally so
 * runtime-boundary violations fail CI instead of the deploy:
 *
 * 1. every isolate entry whose bundle reaches a Node builtin import is
 *    reported with the import chain that drags it in;
 * 2. every isolate entry whose bundle would inline a `'use node'` source file
 *    is reported too — Convex rejects that even when esbuild resolves it;
 * 3. the `'use node'` set must still bundle under platform `node`.
 */

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const convexDirectory = join(workspaceRoot, 'apps/api/convex');

const STUB_NAMESPACE = 'owlat-node-builtin-stub';
const RESOLVE_GUARD = { owlatBuiltinProbe: true };
const USE_NODE_DIRECTIVE = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*(['"])use node\1\s*;?/;
const bareBuiltinFilter = new RegExp(`^(?:${builtinModules.join('|')})$`);

const sourceFiles = await collectConvexModules(convexDirectory);
const useNodeCache = new Map<string, boolean>();
const isolateEntries: string[] = [];
const nodeEntries: string[] = [];
for (const file of sourceFiles) {
	if (await hasUseNodeDirective(file)) nodeEntries.push(file);
	else isolateEntries.push(file);
}

const failures: string[] = [];
const isolateMetafile = await bundleIsolateEntries(isolateEntries, failures);
if (isolateMetafile) {
	await reportUseNodeContamination(isolateMetafile, failures);
}
await bundleNodeEntries(nodeEntries, failures);

if (failures.length > 0) {
	console.error(
		`Convex function-graph smoke found ${failures.length} runtime-boundary violation(s):\n`
	);
	for (const failure of failures) console.error(`${failure}\n`);
	process.exit(1);
}
console.info(
	`Convex function graph is runtime-clean: ${isolateEntries.length} isolate and ${nodeEntries.length} Node entry modules bundled.`
);

async function collectConvexModules(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
		if (/\.test\.tsx?$/.test(entry.name)) continue;
		if (relative(directory, path).split('/').includes('__tests__')) continue;
		files.push(path);
	}
	return files.sort();
}

async function hasUseNodeDirective(path: string): Promise<boolean> {
	let cached = useNodeCache.get(path);
	if (cached === undefined) {
		cached = USE_NODE_DIRECTIVE.test(await readFile(path, 'utf8'));
		useNodeCache.set(path, cached);
	}
	return cached;
}

/**
 * Bundle the isolate set exactly the way Convex's bundler does (see
 * `convexBuild` in `convexBundleSmoke.ts`), except Node builtins resolve to a
 * recording stub instead of failing resolution — so ONE pass surfaces EVERY
 * violation with its import chain rather than stopping at the first missing
 * module.
 */
async function bundleIsolateEntries(
	entryPoints: string[],
	failures: string[]
): Promise<Metafile | null> {
	// importer path (workspace-relative) -> builtin specifiers it imports
	const builtinImports = new Map<string, Set<string>>();
	const outdir = join(tmpdir(), `owlat-convex-function-graph-${process.pid}`);
	try {
		const result = await build({
			absWorkingDir: workspaceRoot,
			entryPoints,
			bundle: true,
			platform: 'browser',
			format: 'esm',
			target: 'esnext',
			conditions: ['convex', 'module'],
			write: true,
			outdir,
			outbase: workspaceRoot,
			metafile: true,
			logLevel: 'silent',
			plugins: [builtinAuditPlugin(builtinImports)],
		});
		reportBuiltinReach(result.metafile, builtinImports, failures);
		return result.metafile;
	} catch (error) {
		failures.push(`isolate bundle failed outright:\n${formatEsbuildError(error)}`);
		return null;
	} finally {
		await rm(outdir, { recursive: true, force: true });
	}
}

function builtinAuditPlugin(builtinImports: Map<string, Set<string>>): Plugin {
	const record = (importer: string, specifier: string) => {
		const key = relative(workspaceRoot, importer);
		const specifiers = builtinImports.get(key) ?? new Set<string>();
		specifiers.add(specifier);
		builtinImports.set(key, specifiers);
	};
	return {
		name: 'owlat-node-builtin-audit',
		setup(build) {
			build.onResolve({ filter: /^node:/ }, (args) => {
				record(args.importer, args.path);
				return { path: args.path, namespace: STUB_NAMESPACE };
			});
			// A bare specifier like `path` is only a builtin when nothing else
			// satisfies it (a node_modules shim or a package.json `browser`
			// mapping would bundle fine), so probe the real resolver first and
			// stub only true fall-throughs; on success, defer back to esbuild.
			build.onResolve({ filter: bareBuiltinFilter }, async (args) => {
				if (args.pluginData === RESOLVE_GUARD) return undefined;
				const probed = await build.resolve(args.path, {
					importer: args.importer,
					resolveDir: args.resolveDir,
					kind: args.kind,
					pluginData: RESOLVE_GUARD,
				});
				if (probed.errors.length === 0) return undefined;
				record(args.importer, args.path);
				return { path: args.path, namespace: STUB_NAMESPACE };
			});
			// CommonJS shape on purpose: named ESM imports from the stub must
			// not add "no matching export" noise on top of the real report.
			build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({
				contents: 'module.exports = {};',
				loader: 'js',
			}));
		},
	};
}

function reportBuiltinReach(
	metafile: Metafile,
	builtinImports: Map<string, Set<string>>,
	failures: string[]
): void {
	if (builtinImports.size === 0) return;
	for (const output of Object.values(metafile.outputs)) {
		if (!output.entryPoint) continue;
		for (const input of Object.keys(output.inputs)) {
			const specifiers = builtinImports.get(input);
			if (!specifiers) continue;
			failures.push(
				`isolate entry ${output.entryPoint} pulls in Node builtin(s) ` +
					`${[...specifiers].map((s) => `'${s}'`).join(', ')} via:\n` +
					`  ${formatImportChain(metafile, output.entryPoint, input)}`
			);
		}
	}
}

/**
 * Convex refuses to inline a `'use node'` module into an isolate bundle even
 * when it happens to resolve, so flag any isolate entry whose metafile inputs
 * include one.
 */
async function reportUseNodeContamination(metafile: Metafile, failures: string[]): Promise<void> {
	for (const output of Object.values(metafile.outputs)) {
		if (!output.entryPoint) continue;
		for (const input of Object.keys(output.inputs)) {
			if (input === output.entryPoint || !/\.tsx?$/.test(input) || input.includes(':')) continue;
			if (!(await hasUseNodeDirective(join(workspaceRoot, input)))) continue;
			failures.push(
				`isolate entry ${output.entryPoint} bundles 'use node' module ${input} via:\n` +
					`  ${formatImportChain(metafile, output.entryPoint, input)}`
			);
		}
	}
}

/** Shortest import chain from an entry module to an offending input. */
function formatImportChain(metafile: Metafile, entry: string, target: string): string {
	const parents = new Map<string, string>([[entry, entry]]);
	const queue = [entry];
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current === target) break;
		for (const edge of metafile.inputs[current]?.imports ?? []) {
			if (edge.external || parents.has(edge.path)) continue;
			parents.set(edge.path, current);
			queue.push(edge.path);
		}
	}
	if (!parents.has(target)) return `${entry} -> ??? -> ${target}`;
	const chain = [target];
	let cursor = target;
	while (cursor !== entry) {
		cursor = parents.get(cursor)!;
		chain.unshift(cursor);
	}
	return chain.join('\n  -> ');
}

/** The `'use node'` set must itself bundle under the Node runtime's platform. */
async function bundleNodeEntries(entryPoints: string[], failures: string[]): Promise<void> {
	const outdir = join(tmpdir(), `owlat-convex-function-graph-node-${process.pid}`);
	try {
		await build({
			absWorkingDir: workspaceRoot,
			entryPoints,
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'esnext',
			conditions: ['convex', 'module'],
			write: true,
			outdir,
			outbase: workspaceRoot,
			logLevel: 'silent',
		});
	} catch (error) {
		failures.push(`Node-runtime bundle failed:\n${formatEsbuildError(error)}`);
	} finally {
		await rm(outdir, { recursive: true, force: true });
	}
}

function formatEsbuildError(error: unknown): string {
	if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
		return error.errors
			.map((message) => {
				const location = message.location
					? `${message.location.file}:${message.location.line}: `
					: '';
				return `  ${location}${message.text}`;
			})
			.join('\n');
	}
	return `  ${String(error)}`;
}
