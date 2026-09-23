/**
 * EVERY CONVEX ENTRY POINT HAS A WAY IN.
 *
 * A Convex function's own suite calls it directly, so `t.mutation(internal.…)`
 * is indistinguishable from production traffic: three ramp seams shipped with
 * no caller and green tests. This walk reads the SOURCE, collects every Convex
 * function exported from `convex/`, and requires each one to be REACHED one of
 * four ways on this deployment:
 *
 *   1. a cron registers it (`internal.<module>.<name>` in `crons.ts` or a module
 *      it delegates registration to);
 *   2. another production Convex module calls it through the generated
 *      `internal`/`api` object, or imports it AND uses the name as a value
 *      (how `http.ts` registers a route handler);
 *   3. a client calls it on `api` — any production module under `apps/**` or
 *      `packages/**`;
 *   4. an out-of-process worker addresses it by string path
 *      (`'<module>:<name>'`, the `ConvexHttpClient` shape).
 *
 * Discovery is pinned as hard as reachability: the builder set is READ from
 * `_generated/server.d.ts`, `lib/authedFunctions.ts`, the `featureGated`
 * wrappers and the exported factories that return a builder, and asserted
 * exactly; an export wrapped in a call this walk cannot classify fails; the two
 * export shapes that hide a door (`export { x }` bound to a builder call and
 * `export default <builder>(`) are refused. Comments are stripped and `typeof`
 * references refused, so prose and type borrows never count as callers.
 *
 * Run by `bun run lint` (apps/api): `bun scripts/check-entry-wiring.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const convexRoot = join(import.meta.dirname, '..', 'convex');
const repoRoot = join(import.meta.dirname, '..', '..', '..');

const failures: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}
function expectEmpty(items: readonly string[], message: string): void {
	if (items.length > 0) failures.push(`${message}\n  ${items.join('\n  ')}`);
}

// Production only: tests are the fabricated callers this walk exists to see
// past, `_generated` names every function without calling one, build outputs
// are copies. `.well-known` is a live Nuxt route directory, so only these names
// are skipped, never every dot-prefixed directory.
const SKIPPED_DIRECTORIES = new Set([
	'__tests__',
	'_generated',
	'node_modules',
	'dist',
	'.nuxt',
	'.output',
	'build',
	'coverage',
]);

function productionModules(dir: string, extensions: readonly string[]): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			found.push(...productionModules(full, extensions));
			continue;
		}
		if (entry.name.endsWith('.test.ts')) continue;
		if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
	}
	return found.sort();
}

// `<!-- -->` first so a full HTML comment is gone before `//` can eat its
// terminator; `//` cut wherever it appears, because over-stripping fails loud
// here while under-stripping credits an orphan with a mention.
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');
}

function sourceMap(files: readonly string[], root: string): Map<string, string> {
	return new Map(
		files.map((file) => [
			relative(root, file).split('\\').join('/'),
			stripComments(readFileSync(file, 'utf8')),
		])
	);
}

const CONVEX_SOURCES = sourceMap(productionModules(convexRoot, ['.ts']), convexRoot);
// Every client of this backend, not just the web app: apps/** and packages/**
// minus convex/ itself.
const CLIENT_SOURCES = sourceMap(
	['apps', 'packages']
		.flatMap((workspace) => productionModules(join(repoRoot, workspace), ['.ts', '.vue']))
		.filter((file) => !file.startsWith(`${convexRoot}/`)),
	repoRoot
);

const AUTHED_FUNCTIONS = 'lib/authedFunctions.ts';

function convexSource(file: string): string {
	const source = CONVEX_SOURCES.get(file);
	if (source === undefined) throw new Error(`${file} is missing from the walk`);
	return source;
}

// ─── The builder set, read from source ──────────────────────────────────────

function generatedBuilders(): string[] {
	const declarations = readFileSync(join(convexRoot, '_generated', 'server.d.ts'), 'utf8');
	const declared = /export declare const ([A-Za-z_$][\w$]*):\s*[A-Za-z_$][\w$]*Builder\b/g;
	return [...declarations.matchAll(declared)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]]
	);
}

function wrapperBuilders(): string[] {
	const exported = [
		...convexSource(AUTHED_FUNCTIONS).matchAll(/export const ([A-Za-z_$][\w$]*)\s*=/g),
	].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
	// `featureGated` (single flag) and `featureGatedAny` (any-of) both return a
	// builder of the wrapped builder's own type, so a module-local
	// `const chatQuery = featureGated(...)` / `const postboxQuery =
	// featureGatedAny(...)` is a door like any other.
	const gated = [...CONVEX_SOURCES.values()].flatMap((source) =>
		[...source.matchAll(/\bconst ([A-Za-z_$][\w$]*)\s*=\s*featureGated(?:Any)?\(/g)].flatMap(
			(match) => (match[1] === undefined ? [] : [match[1]])
		)
	);
	return [...exported, ...gated];
}

// Exported functions that RETURN a builder call (`publicTokenEndpoint`,
// `createAuthenticatedHandler`). The body is read up to the first line-anchored
// `}` — conservative: an under-read body surfaces as an unclassified wrapper.
function factoryBuilders(direct: readonly string[]): string[] {
	const returnsBuilder = new RegExp(`return\\s+(?:${direct.join('|')})\\s*\\(`);
	return [...CONVEX_SOURCES.values()].flatMap((source) =>
		[...source.matchAll(/export function ([A-Za-z_$][\w$]*)[\s\S]*?\n}/g)].flatMap((match) =>
			match[1] !== undefined && returnsBuilder.test(match[0]) ? [match[1]] : []
		)
	);
}

const DIRECT_BUILDERS = [...new Set([...generatedBuilders(), ...wrapperBuilders()])];
const ENTRY_BUILDERS: readonly string[] = [
	...new Set([...DIRECT_BUILDERS, ...factoryBuilders(DIRECT_BUILDERS)]),
].sort();

// A genuinely new builder belongs on this list; a builder that ships without
// landing here means discovery stopped seeing one of the declaration shapes.
const EXPECTED_BUILDERS: readonly string[] = [
	'action',
	'adminMutation',
	'adminQuery',
	'assistantMutation',
	'assistantQuery',
	'authedAction',
	'authedIdentityMutation',
	'authedMutation',
	'authedQuery',
	'chatMutation',
	'chatQuery',
	'createAuthenticatedHandler',
	'httpAction',
	'internalAction',
	'internalMutation',
	'internalQuery',
	'mutation',
	'ownerMutation',
	'postboxMutation',
	'postboxQuery',
	'providerFeedbackWebhook',
	'publicAction',
	'publicMutation',
	'publicQuery',
	'publicTokenEndpoint',
	'query',
];

// Exports wrapped in a call that is deliberately NOT an entry point — every one
// a factory over plain data. The walk fails on an unclassified wrapper rather
// than assuming it.
const NOT_ENTRY_BUILDERS: Readonly<Record<string, string>> = {
	composeProviderBundles: 'validates and indexes plain provider bundle data',
	composeBundledPlugins: 'folds the generated plugin manifests into one composition object',
	createFeatureFlagRegistry: 'builds the plugin feature-flag lookup map',
	defineStep: 'declares one workspace-deletion step — data the deletion walker reads',
	featureGated: 'RETURNS a builder; its products are collected as builders above',
	featureGatedAny: 'RETURNS a builder (any-of flag floor); same as featureGated',
	gateIds: 'projects a gate list to its ids',
	getBundledPluginFeatureFlagDefinitions: 'reads the generated flag definitions',
	literalUnion: 'builds a Convex validator from a literal tuple',
	urgencyFallbackScore: 'maps an urgency label to its numeric score',
};

// A `migrations/` module is a one-shot backfill an operator runs by hand
// (`convex run migrations/<file>:run`); a caller would be a migration that
// fires itself.
const HAND_RUN_PREFIXES: readonly string[] = ['migrations/'];
const isHandRun = (module: string): boolean =>
	HAND_RUN_PREFIXES.some((prefix) => module.startsWith(prefix));

// ─── Discovery ──────────────────────────────────────────────────────────────

// `\s*` around the `=`: the formatter wraps `export const x =\n\tinternalMutation(`.
const ENTRY_DECLARATION = new RegExp(
	`export const ([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${ENTRY_BUILDERS.join('|')})\\s*\\(`,
	'g'
);
const EXPORTED_CALL = /export const ([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g;

interface ConvexEntry {
	readonly module: string;
	readonly name: string;
}

function entriesIn(module: string, source: string): ConvexEntry[] {
	return [...source.matchAll(ENTRY_DECLARATION)].flatMap((match) =>
		match[1] === undefined ? [] : [{ module, name: match[1] }]
	);
}

// `export { x }` bound to a builder call and `export default <builder>(` — the
// shapes that put a Convex function on a module's surface where discovery
// cannot see it. Refused precisely, not at the module surface: `export { … }`
// is live barrel idiom and `export default` is required of schema/http/crons.
function indirectEntryExports(module: string, source: string): string[] {
	const found: string[] = [];
	const builderBinding = (name: string): boolean =>
		new RegExp(`(?:^|\\n)\\s*const ${name}\\s*=\\s*(?:${ENTRY_BUILDERS.join('|')})\\s*\\(`).test(
			source
		);
	for (const clause of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const specifier of (clause[1] ?? '').split(',')) {
			const name = specifier
				.trim()
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name === undefined || name.length === 0 || /^type\b/.test(name)) continue;
			if (builderBinding(name)) found.push(`${module}#${name} (export { … })`);
		}
	}
	if (new RegExp(`^export default\\s+(?:${ENTRY_BUILDERS.join('|')})\\s*\\(`, 'm').test(source)) {
		found.push(`${module}#default (export default)`);
	}
	return found;
}

const CONVEX_ENTRIES: ConvexEntry[] = [...CONVEX_SOURCES.keys()]
	.sort()
	.flatMap((module) => entriesIn(module, CONVEX_SOURCES.get(module) ?? ''));

// ─── Reachability ───────────────────────────────────────────────────────────

const IMPORT_DECLARATION = /^import\s+(?!type\b)([\s\S]*?)\s*from\s*'([^']+)';/gm;
const ANY_IMPORT = /^import\s+[\s\S]*?\s*from\s*'[^']+';/gm;
// `internal.a.b.name` / `api.a.b.name`, with a `typeof` in front refused: that
// is the type-borrowing shape, and the entry it names may have no caller.
const GENERATED_REFERENCE =
	/(?<!typeof\s+)\b(?:internal|api)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g;
// `'mail/imap/fetch:fetchEnvelopes'` — the ConvexHttpClient string path.
const WORKER_REFERENCE = /'([\w/.-]+):([A-Za-z_$][\w$]*)'/g;

function boundNames(clause: string): string[] {
	return clause
		.replace(/[{}]/g, ' ')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !/^type\s/.test(entry))
		.flatMap((entry) => entry.split(/\s+as\s+/).map((part) => part.trim()))
		.filter((entry) => entry.length > 0);
}

// Both resolutions of a relative specifier: `./seedDemo` is `seedDemo/index.ts`.
function resolveRelative(from: string, specifier: string): string[] {
	if (!specifier.startsWith('.')) return [];
	const base = join(dirname(from), specifier.replace(/\.js$/, '')).split('\\').join('/');
	return [`${base}.ts`, `${base}/index.ts`];
}

/** Everything one module names, indexed once so the walk is a set lookup per entry. */
interface References {
	/** Dotted generated paths and every dotted prefix of them (`a.b.c` names `a/b.ts#c` too). */
	readonly generated: ReadonlySet<string>;
	readonly workers: ReadonlySet<string>;
	readonly imports: readonly {
		readonly targets: readonly string[];
		readonly names: readonly string[];
	}[];
	/** The source with its import statements cut, so a binding never counts as its own use. */
	readonly body: string;
}

function indexReferences(file: string, source: string): References {
	const generated = new Set<string>();
	for (const match of source.matchAll(GENERATED_REFERENCE)) {
		const parts = (match[1] ?? '').split('.');
		for (let depth = 2; depth <= parts.length; depth += 1)
			generated.add(parts.slice(0, depth).join('.'));
	}
	const workers = new Set<string>();
	for (const match of source.matchAll(WORKER_REFERENCE)) workers.add(`${match[1]}:${match[2]}`);
	const imports = [...source.matchAll(IMPORT_DECLARATION)].map((match) => ({
		targets: resolveRelative(file, match[2] ?? ''),
		names: boundNames(match[1] ?? ''),
	}));
	return { generated, workers, imports, body: source.replace(ANY_IMPORT, '') };
}

const CONVEX_REFERENCES = new Map(
	[...CONVEX_SOURCES].map(([file, source]) => [file, indexReferences(file, source)])
);
const CLIENT_REFERENCES = new Map(
	[...CLIENT_SOURCES].map(([file, source]) => [file, indexReferences(file, source)])
);

const generatedPath = (entry: ConvexEntry): string =>
	`${entry.module.replace(/\.ts$/, '').split('/').join('.')}.${entry.name}`;
const workerPath = (entry: ConvexEntry): string =>
	`${entry.module.replace(/\.ts$/, '')}:${entry.name}`;

function addresses(references: References, entry: ConvexEntry): boolean {
	return (
		references.generated.has(generatedPath(entry)) || references.workers.has(workerPath(entry))
	);
}

// A value import wires an entry up only if the importer USES the name as a
// value; `typeof x` is `import type` one syntax over and is refused.
function importsAndUses(references: References, entry: ConvexEntry): boolean {
	const imported = references.imports.some(
		({ targets, names }) => targets.includes(entry.module) && names.includes(entry.name)
	);
	return (
		imported && new RegExp(`(?<!typeof\\s+)(?<![\\w$.])${entry.name}\\b`).test(references.body)
	);
}

function callersOf(entry: ConvexEntry): string[] {
	const callers: string[] = [];
	for (const [file, references] of CONVEX_REFERENCES) {
		if (file === entry.module) continue;
		if (addresses(references, entry) || importsAndUses(references, entry)) callers.push(file);
	}
	for (const [file, references] of CLIENT_REFERENCES) {
		if (addresses(references, entry)) callers.push(`client:${file}`);
	}
	return callers.sort();
}

const label = (entry: ConvexEntry): string => `${entry.module}#${entry.name}`;

// Pass one: cross-module callers. Pass two: a REACHED entry handing a SIBLING
// of the same module to the scheduler is a live continuation, iterated to a
// fixed point. An entry whose only same-module reference is itself stays an
// orphan (the self-schedule refusal).
function reachedEntries(entries: readonly ConvexEntry[]): ReadonlySet<string> {
	const reached = new Set(entries.filter((entry) => callersOf(entry).length > 0).map(label));
	let grew = true;
	while (grew) {
		grew = false;
		for (const entry of entries) {
			if (reached.has(label(entry))) continue;
			const own = CONVEX_REFERENCES.get(entry.module);
			if (own === undefined || !addresses(own, entry)) continue;
			const throughSibling = entries.some(
				(other) =>
					other.module === entry.module && other.name !== entry.name && reached.has(label(other))
			);
			if (throughSibling) {
				reached.add(label(entry));
				grew = true;
			}
		}
	}
	return reached;
}

/**
 * THE LEDGER — entries nothing can start, written down as pre-existing debt.
 * Exact in both directions: a new orphan fails until it is registered, called
 * or deleted; a listed entry that gains a caller or is deleted fails until its
 * line comes off. Empty, and the empty state is the point (issue #528).
 */
const UNREACHED_ENTRIES: readonly string[] = [];

/**
 * PREVIOUS-RELEASE ENTRY POINTS — kept for one release because the previous
 * release reaches them by path during the deploy window: its actions still
 * running when the new functions go live, and scheduler jobs it queued before
 * the deploy (`CONVENTIONS.md`, "Old clients and workers against new
 * functions"). Nothing in this release calls them, which is the point. Each
 * line names why it stays; the next release deletes the entry and its line.
 * Exact in both directions like the ledger above.
 */
const PREVIOUS_RELEASE_ENTRIES: Readonly<Record<string, string>> = {
	'webhooks/fanout.ts#fanoutEvent': 'fanout jobs queued before the deploy',
	'webhooks/fanout.ts#deliverEvent': 'single-target jobs queued before the deploy',
};

// ─── The checks ─────────────────────────────────────────────────────────────

check(CONVEX_SOURCES.size > 500, `walked only ${CONVEX_SOURCES.size} backend modules`);
check(CLIENT_SOURCES.size > 500, `walked only ${CLIENT_SOURCES.size} client modules`);
expectEmpty(
	[...CONVEX_SOURCES.keys(), ...CLIENT_SOURCES.keys()].filter(
		(file) => file.includes('__tests__') || file.endsWith('.test.ts')
	),
	'the walk includes test files'
);
for (const landmark of ['crons.ts', 'delivery/cronRegistration.ts']) {
	check(CONVEX_SOURCES.has(landmark), `${landmark} dropped out of the backend walk`);
}
for (const landmark of [
	'apps/web/app/pages/dashboard/admin/delivery/advanced/controls.vue',
	'apps/web/server/api/system/update.post.ts',
	'apps/mail-sync/src/convex.ts',
]) {
	check(CLIENT_SOURCES.has(landmark), `${landmark} dropped out of the client walk`);
}

check(
	JSON.stringify(ENTRY_BUILDERS) === JSON.stringify(EXPECTED_BUILDERS),
	`the builder set changed: ${JSON.stringify(ENTRY_BUILDERS)} — a new builder joins EXPECTED_BUILDERS, a missing one means discovery stopped seeing a declaration shape`
);

expectEmpty(
	[...CONVEX_SOURCES.entries()].flatMap(([module, source]) =>
		[...source.matchAll(EXPORTED_CALL)]
			.filter(
				(match) =>
					!ENTRY_BUILDERS.includes(match[2] ?? '') && !((match[2] ?? '') in NOT_ENTRY_BUILDERS)
			)
			.map((match) => `${module}#${match[1]} = ${match[2]}(`)
	),
	'an export is wrapped in a call this walk cannot classify — it joins ENTRY_BUILDERS if it builds a Convex function, or NOT_ENTRY_BUILDERS with the reason it is no door:'
);
for (const wrapper of Object.keys(NOT_ENTRY_BUILDERS)) {
	check(!ENTRY_BUILDERS.includes(wrapper), `${wrapper} is both a builder and a non-door`);
}

expectEmpty(
	[...CONVEX_SOURCES.entries()].flatMap(([module, source]) => indirectEntryExports(module, source)),
	'a module puts a Convex function on its surface with `export { … }` or `export default` — invisible to this walk, so declare it as `export const <name> = <builder>(`:'
);

check(CONVEX_ENTRIES.length > 1_400, `found only ${CONVEX_ENTRIES.length} entry points`);
for (const landmark of [
	'delivery/rampControllerCron.ts#runRampController',
	'delivery/rampControls.ts#setCellPause',
]) {
	check(
		CONVEX_ENTRIES.some((entry) => label(entry) === landmark),
		`${landmark} not discovered`
	);
}

const reached = reachedEntries(CONVEX_ENTRIES);
const unreachedWithShims = CONVEX_ENTRIES.filter(
	(entry) => !isHandRun(entry.module) && !reached.has(label(entry))
).map(label);
const unreached = unreachedWithShims.filter((entry) => !(entry in PREVIOUS_RELEASE_ENTRIES));

expectEmpty(
	Object.keys(PREVIOUS_RELEASE_ENTRIES).filter((entry) => !unreachedWithShims.includes(entry)),
	'a previous-release entry gained a caller or was deleted — take its line out of PREVIOUS_RELEASE_ENTRIES:'
);

expectEmpty(
	unreached.filter((entry) => !UNREACHED_ENTRIES.includes(entry)),
	'a Convex entry point has no cron registration, no production caller, no client call and no worker path — register it, call it, or delete it (UNREACHED_ENTRIES is for pre-existing debt only):'
);
expectEmpty(
	UNREACHED_ENTRIES.filter((entry) => !unreached.includes(entry)),
	'a ledger entry is now reachable, or was deleted — take its line out of UNREACHED_ENTRIES:'
);
expectEmpty(
	UNREACHED_ENTRIES.filter((entry) => entry.startsWith('delivery/ramp')),
	'the ramp — the reason this walk exists — may carry nothing on the ledger:'
);
// The one entry whose only non-test caller is a cron table; it also
// self-schedules, which is precisely the reference the walk must not credit.
check(
	JSON.stringify(
		callersOf({ module: 'delivery/rampControllerCron.ts', name: 'runRampController' })
	) === JSON.stringify(['delivery/cronRegistration.ts']),
	'runRampController must be reached through its cron registration and nothing else'
);

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log(
	`check-entry-wiring: OK (${CONVEX_ENTRIES.length} entry points, ${UNREACHED_ENTRIES.length} on the ledger, ${Object.keys(PREVIOUS_RELEASE_ENTRIES).length} kept for the previous release)`
);
