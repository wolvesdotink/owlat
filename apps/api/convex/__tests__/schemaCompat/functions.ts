import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ValidatorJSON } from 'convex/values';
import { containmentGap, withoutValidatorField } from './containment';

/**
 * The calling side of a release's function contract: for each Convex function
 * a previous-release caller can reach, how it is called (query, mutation or
 * action; public or internal) and the arguments its validator accepts, as
 * `exportArgs()` reports them to the deployment. Read by importing the modules,
 * not by parsing them, so wrappers that add or rewrite arguments (the authed
 * builders, `featureGated`) are seen exactly as Convex sees them.
 *
 * A previous release's callers are its web and desktop clients, which can call
 * any public function, and its separately deployed workers (IMAP, mail-sync,
 * code-worker, ...), which also call internal functions with the admin key,
 * addressing each by its string path. Result shapes are not part of this
 * contract yet.
 */

type FunctionKind = 'query' | 'mutation' | 'action';
type FunctionVisibility = 'public' | 'internal';

export type FunctionSignature = {
	kind: FunctionKind;
	visibility: FunctionVisibility;
	args: ValidatorJSON;
};

/** What `registration_impl` puts on a registered function. */
type RegisteredFunction = {
	isQuery?: boolean;
	isMutation?: boolean;
	isAction?: boolean;
	isPublic?: boolean;
	isInternal?: boolean;
	exportArgs: () => string;
};

function isRegisteredFunction(value: unknown): value is RegisteredFunction {
	return (
		typeof value === 'function' &&
		typeof (value as { exportArgs?: unknown }).exportArgs === 'function' &&
		(value as { isHttp?: boolean }).isHttp !== true
	);
}

/**
 * The function modules under `convexRoot`, as Convex paths (`mail/imap/fetch`),
 * by the CLI's own entry-point rules (`convex/dist/esm/bundler`): `.ts` files
 * outside `_generated`, no dotfiles, no `schema.ts`, no name with more than one
 * dot. Tests and component directories are left out; neither is the app's API.
 */
export function functionModules(convexRoot: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (['_generated', '__tests__', 'node_modules'].includes(entry.name)) continue;
				if (entry.name.startsWith('.')) continue;
				if (existsSync(join(full, 'convex.config.ts'))) continue;
				walk(full);
				continue;
			}
			const name = entry.name;
			if (!name.endsWith('.ts') || name.startsWith('.') || name.startsWith('#')) continue;
			if (name === 'schema.ts' || (name.match(/\./g) ?? []).length > 1) continue;
			found.push(relative(convexRoot, full).split('\\').join('/').replace(/\.ts$/, ''));
		}
	};
	walk(convexRoot);
	return found.sort();
}

/** `module:export` → signature, for every function the given modules register. */
export async function readFunctions(
	convexRoot: string,
	modules: readonly string[]
): Promise<Record<string, FunctionSignature>> {
	const functions: Record<string, FunctionSignature> = {};
	for (const module of modules) {
		const exports = (await import(join(convexRoot, `${module}.ts`))) as Record<string, unknown>;
		for (const [name, value] of Object.entries(exports)) {
			if (!isRegisteredFunction(value)) continue;
			const kind: FunctionKind | null = value.isQuery
				? 'query'
				: value.isMutation
					? 'mutation'
					: value.isAction
						? 'action'
						: null;
			if (kind === null) continue;
			functions[`${module}:${name}`] = {
				kind,
				visibility: value.isPublic ? 'public' : 'internal',
				args: JSON.parse(value.exportArgs()) as ValidatorJSON,
			};
		}
	}
	return functions;
}

/**
 * A worker's string path to a function: `'mail/imap/fetch:fetchEnvelopes'`,
 * the shape `makeFunctionReference` and `ConvexHttpClient` take. The same
 * pattern `scripts/check-entry-wiring.ts` counts as a worker caller.
 */
const WORKER_REFERENCE = /'([\w/.-]+):([A-Za-z_$][\w$]*)'/g;

/** Every function path the given worker sources name. */
export function workerPaths(sources: Iterable<string>): Set<string> {
	const paths = new Set<string>();
	for (const source of sources) {
		for (const match of source.matchAll(WORKER_REFERENCE)) paths.add(`${match[1]}:${match[2]}`);
	}
	return paths;
}

/**
 * What a release's callers can reach: every public function, and each
 * internal one a worker names by path.
 */
export function callerSurface(
	functions: Readonly<Record<string, FunctionSignature>>,
	workers: ReadonlySet<string>
): Record<string, FunctionSignature> {
	return Object.fromEntries(
		Object.entries(functions).filter(
			([path, signature]) => signature.visibility === 'public' || workers.has(path)
		)
	);
}

const withArticle = (kind: FunctionKind): string => `${kind === 'action' ? 'an' : 'a'} ${kind}`;

/**
 * Every way a call the previous release could make is refused now: the
 * function is gone or renamed, it changed kind, it went from public to
 * internal, or its validator does not accept everything the previous one did
 * (an argument removed or renamed, a new required one, an optional one made
 * required, a changed or narrowed type, a narrowed union). Proved from the two
 * validators' structure (`containment.ts`), not from sample calls.
 *
 * `retired` names functions deliberately removed, and `retiredArguments`
 * arguments deliberately removed (as paths, see `withoutValidatorField`), both
 * in the contract step after the previous release stopped calling or sending
 * them.
 */
export function callIncompatibilities(
	previous: Readonly<Record<string, FunctionSignature>>,
	current: Readonly<Record<string, FunctionSignature>>,
	retired: ReadonlySet<string> = new Set(),
	retiredArguments: Readonly<Record<string, readonly string[]>> = {}
): string[] {
	const problems: string[] = [];
	for (const [path, before] of Object.entries(previous)) {
		const now = current[path];
		if (!now) {
			if (!retired.has(path)) problems.push(`${path}: function is no longer exported`);
			continue;
		}
		if (now.kind !== before.kind) {
			problems.push(`${path}: was ${withArticle(before.kind)}, now ${withArticle(now.kind)}`);
			continue;
		}
		if (before.visibility === 'public' && now.visibility === 'internal') {
			problems.push(`${path}: was public, now internal`);
			continue;
		}
		const sent = (retiredArguments[path] ?? []).reduce(withoutValidatorField, before.args);
		const problem = containmentGap(now.args, sent, '(arguments)');
		if (problem) problems.push(`${path}: ${problem}`);
	}
	return problems;
}
