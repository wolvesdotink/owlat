/**
 * EVERY CONVEX ENTRY POINT HAS A WAY IN.
 *
 * Three ramp seams shipped with no caller and survived review, because a Convex
 * function's own suite calls it directly: `t.mutation(internal.…)` is
 * indistinguishable from production traffic to every assertion in the file. So
 * the suite is green, the function is correct, and nothing on the instance can
 * ever run it. `rampControllerCron.promoteRampPhase` was the third, removed
 * under D20 in #507 rather than given an invented caller; `snds.getMicrosoftGateInput`
 * was the fourth, removed the same way in #515.
 *
 * The defect is not ramp-shaped. "A Convex entry point nothing on the instance
 * can start" is a `convex/`-wide property, so this walk covers the whole backend
 * (issue #509). It reads the SOURCE, not fixtures: it collects every Convex
 * function exported from `convex/` and requires each one to be REACHED by one of
 * the four ways an entry point is reached on this deployment.
 *
 *   1. A CRON REGISTERS IT — `internal.<module>.<name>` in `crons.ts` or a
 *      module it delegates registration to (`delivery/cronRegistration.ts`).
 *   2. ANOTHER PRODUCTION CONVEX MODULE CALLS IT — addressed through the
 *      generated `internal`/`api` object (how a scheduled or `runQuery`'d entry
 *      is called), or imported AND used as a value (how `http.ts` registers a
 *      route handler).
 *   3. A CLIENT CALLS IT ON `api` — any production module under `apps/**` or
 *      `packages/**`, which is the web app, the desktop shell, the SDK and the
 *      Nuxt server routes. Not `apps/web` alone: `apps/web` was the whole client
 *      surface when this walk covered `delivery/ramp*.ts` and is not the whole
 *      client surface of the backend.
 *   4. AN OUT-OF-PROCESS WORKER ADDRESSES IT BY STRING PATH — `'<module>:<name>'`,
 *      the shape `apps/mail-sync`, `apps/imap` and `apps/code-worker` use because
 *      they hold a `ConvexHttpClient` and not the generated API object (see
 *      `apps/mail-sync/src/convex.ts`). `scripts/check-convex-plugin-orphans.ts`
 *      already knows this route at module level; missing it here would have
 *      reported the seed-probe poller's live entries as dead.
 *
 * All four collapse into one question — "does some production module NAME this
 * export" — so they share the walk; the cron route is pinned separately below so
 * that a registration file dropped out of the walk fails here rather than
 * quietly stops counting.
 *
 * DISCOVERY IS HALF THE GUARD. An entry the walk never finds is reported as
 * reachable by silence, which is the same outcome as having no guard at all, so
 * the collection side is pinned as hard as the reachability side: the builder
 * set is READ from `lib/authedFunctions.ts`, `_generated/server.d.ts`, the
 * `featureGated` wrappers and the exported FACTORIES that return a builder call
 * (`publicTokenEndpoint`, `createAuthenticatedHandler`) rather than listed from
 * memory, the declaration pattern accepts the wrapped `const x =\n\tinternalMutation(`
 * shape the formatter produces, the builder set is asserted EXACTLY, and any
 * export wrapped in a call this file cannot classify fails outright. The anchor
 * of all of it is `export const`, so the two shapes that put a Convex function on
 * a module's surface WITHOUT one — `export { name };` and `export default` — are
 * refused WHERE THEY WOULD HIDE ONE.
 *
 * TWO MENTIONS DO NOT COUNT, and both are shapes this repo actually contains:
 * a PROSE mention (`rampPhasePromotion.promoteCellPhase` is discussed in half a
 * dozen docblocks), and a TYPE position (`FunctionReturnType<typeof
 * api.delivery.rampEnrollment.enrollCell>` in `deliverabilityRamp.ts` names an
 * entry to borrow its return type and wires up nothing). Comments are stripped
 * in every syntax the walk crosses — both JavaScript ones on the backend, plus
 * the `<!-- -->` of the `.vue` templates that are most of the client half — and
 * `typeof` references are refused on the generated path AND on the import path,
 * which is the same borrow one syntax over. Otherwise the guard decays into a
 * grep for the function's own name, which every orphan passes.
 *
 * WHY A TEST AND NOT A LINT SCRIPT. `scripts/check-convex-plugin-orphans.ts` is
 * the module-level cousin of this walk and covers `convex/plugins/` only. It
 * answers "is this MODULE reached", which most modules are — they export helpers
 * their neighbours import. The dead seam is one EXPORT inside a live module, so
 * the unit has to be the function, and the classification rules that unit needs
 * (which wrappers build a door, which export shapes hide one) are themselves
 * assertions with fixtures. Those fixtures are the half of this file that keeps
 * the other half honest, and they are a test suite whatever file they live in.
 * The two gates run in the same CI job either way.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const convexRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(convexRoot, '..', '..', '..');

/**
 * PRODUCTION ONLY. `__tests__` is excluded because a test caller is exactly the
 * fabricated way in this guard exists to see past, `_generated` because codegen
 * names every function without calling any of them, and the build outputs
 * because a compiled copy of a caller is not a second caller.
 */
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
			if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
			found.push(...productionModules(full, extensions));
			continue;
		}
		if (entry.name.endsWith('.test.ts')) continue;
		if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
	}
	return found.sort();
}

/**
 * Prose is not a call site — this file's subject matter is discussed at length,
 * on whole comment lines AND after code (`await other(); // superseded by …`).
 * `//` is cut wherever it appears rather than only at a line start: the cost of
 * over-stripping is a caller this walk fails to see, which fails loudly here,
 * while under-stripping credits an orphan with a mention and fails nowhere.
 *
 * `<!-- -->` for the same reason one file type over: the client half of the walk
 * is largely `.vue`, where an HTML comment is how a template is commented out,
 * so a superseded `api.delivery.…` line left in a template would credit the
 * entry it names with a production caller. Cut FIRST, so a full HTML comment is
 * gone before `//` can eat its terminator (`<!-- see https://x -->`).
 */
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

/**
 * EVERY CLIENT OF THIS BACKEND, not just the web app: `apps/**` and
 * `packages/**` minus `convex/` itself. That covers the Nuxt app and its server
 * routes, the desktop shell, the SDK and the four out-of-process workers, and it
 * needs no list to keep current — a client added to the monorepo joins the walk
 * the day it ships, which is the property a hardcoded root list cannot have.
 */
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

/**
 * THE BUILDER SET, READ FROM SOURCE. A hardcoded list narrows silently: the day
 * a builder ships that is not on it, every export wrapped in that builder stops
 * being an entry point as far as this walk is concerned, and an orphan declared
 * with it passes. So the names are collected from the four places this backend
 * makes a builder:
 *
 *   - `_generated/server.d.ts` — the codegen builders, `httpAction` included;
 *   - `lib/authedFunctions.ts` — every `export const` of it, because that module
 *     IS the builder module (a non-builder const added there widens discovery,
 *     which fails loud in the walk below, never silently narrows it);
 *   - `featureGated(<builder>, <flag>)` wrappers wherever they are declared —
 *     `chatMutation`, `assistantQuery` and their kin, exported or module-local;
 *   - FACTORY FUNCTIONS whose body returns a builder call. `publicTokenEndpoint`
 *     and `auth/apiAuth.ts`'s `createAuthenticatedHandler` both wrap `httpAction`
 *     and hand it back, so `export const getContact = createAuthenticatedHandler(…)`
 *     is a door with an unfamiliar name on it. Derived rather than named: this
 *     file listed `publicTokenEndpoint` outright while the walk covered
 *     `delivery/ramp*.ts` and no ramp module declared one, and widening the scope
 *     immediately turned up the second factory nobody had thought to add.
 */
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
	const gated = [...CONVEX_SOURCES.values()].flatMap((source) =>
		[...source.matchAll(/\bconst ([A-Za-z_$][\w$]*)\s*=\s*featureGated\(/g)].flatMap((match) =>
			match[1] === undefined ? [] : [match[1]]
		)
	);
	return [...exported, ...gated];
}

/**
 * Exported `function`s that RETURN a builder call. The body is matched up to the
 * first line-anchored `}`, which is where a top-level function declaration ends
 * in this formatter's output — deliberately conservative: an under-read body
 * misses a factory and that shows up as an unclassified wrapper below, while an
 * over-read one would claim a builder for the next function down.
 */
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

/**
 * Exports wrapped in a call that is deliberately NOT an entry point — every one
 * of them a factory over plain data, not over a Convex function. The walk fails
 * on an unclassified wrapper rather than assuming it, so this list is the record
 * of the ones that have been looked at, and the reason each is no door.
 */
const NOT_ENTRY_BUILDERS: Readonly<Record<string, string>> = {
	composeProviderBundles: 'validates and indexes plain provider bundle data',
	composeBundledPlugins: 'folds the generated plugin manifests into one composition object',
	createFeatureFlagRegistry: 'builds the plugin feature-flag lookup map',
	defineStep: 'declares one workspace-deletion step — data the deletion walker reads',
	featureGated: 'RETURNS a builder; its products are collected as builders above',
	gateIds: 'projects a gate list to its ids',
	getBundledPluginFeatureFlagDefinitions: 'reads the generated flag definitions',
	literalUnion: 'builds a Convex validator from a literal tuple',
	urgencyFallbackScore: 'maps an urgency label to its numeric score',
};

/**
 * WHERE THE WALK CANNOT SEE THE ROUTE, and the route is real.
 *
 * A `migrations/` module is a one-shot backfill invoked BY HAND after a deploy
 * (`convex run migrations/0035_seal_bodies_at_rest:run`). Nothing calls it and
 * nothing should: a caller would be a migration that runs itself, which is the
 * defect the directory's numbering exists to prevent. Every other entry in the
 * backend is reached from code or is on the ledger below.
 */
const HAND_RUN_PREFIXES: Readonly<Record<string, string>> = {
	'migrations/':
		'one-shot backfills an operator runs with `convex run <module>:run` after a deploy; a caller would be a migration that fires itself',
};

function isHandRun(module: string): boolean {
	return Object.keys(HAND_RUN_PREFIXES).some((prefix) => module.startsWith(prefix));
}

/**
 * `\s*` around the `=` on purpose: the formatter wraps a long declaration onto
 * the line after it (`export const x =\n\tinternalMutation({…})`), a shape
 * `apps/api/scripts/check-public-functions.sh` carries its own two-line awk pass
 * for because it occurs. A single-space pattern skips those declarations, and an
 * entry discovery never makes is reported reachable by silence.
 */
const ENTRY_DECLARATION = new RegExp(
	`export const ([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${ENTRY_BUILDERS.join('|')})\\s*\\(`,
	'g'
);

/** `export const x = someCall(` — the shape an entry declaration takes at all. */
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

/**
 * `export { x };` and `export default …` — the two shapes that put a value on a
 * module's surface WITHOUT an `export const` for discovery (or its
 * unclassified-wrapper backstop, which is anchored the same way) to read. Convex
 * registers a function exported either way, so an entry declared like that is a
 * live door neither half of the walk can see.
 *
 * REFUSED PRECISELY, not at the module surface. A blanket refusal was affordable
 * while this walk covered thirteen ramp modules; backend-wide it is not, because
 * `export { … }` is live house idiom under `convex/` (forty-odd barrels) and
 * `export default` is REQUIRED of `schema.ts`, `http.ts`, `crons.ts`,
 * `convex.config.ts` and `auth.config.ts` — the Convex CLI resolves those exact
 * filenames and reads exactly that export. So the rule reads the binding instead:
 * a clause name bound to `const x = <builder>(`, or a default export that IS a
 * builder call, is the hidden door and nothing else is. That is discovery
 * widening rather than a naming taboo, which is what the narrower version of this
 * file said the alternative was.
 */
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

/**
 * `import { a, b } from './x';` — clause and specifier. `import type` is skipped
 * whole: a module that borrows an entry's argument or result TYPE has not wired
 * it up, and crediting that is how a reachability check decays into a grep.
 */
const IMPORT_DECLARATION = /^import\s+(?!type\b)([\s\S]*?)\s*from\s*'([^']+)';/gm;

/** Every import, type ones included — cut before a name's USES are counted. */
const ANY_IMPORT = /^import\s+[\s\S]*?\s*from\s*'[^']+';/gm;

function boundNames(clause: string): string[] {
	return clause
		.replace(/[{}]/g, ' ')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !/^type\s/.test(entry))
		.flatMap((entry) => entry.split(/\s+as\s+/).map((part) => part.trim()))
		.filter((entry) => entry.length > 0);
}

/**
 * BOTH RESOLUTIONS OF A RELATIVE SPECIFIER, because the backend writes both:
 * `./seedDemo` is `seedDemo/index.ts`, and `http.ts` registers its HTTP action
 * through exactly that import. Resolving only `<specifier>.ts` reported a
 * registered route handler as an orphan.
 */
function resolveRelative(from: string, specifier: string): string[] {
	if (!specifier.startsWith('.')) return [];
	const base = join(dirname(from), specifier.replace(/\.js$/, '')).split('\\').join('/');
	return [`${base}.ts`, `${base}/index.ts`];
}

/**
 * `internal.delivery.rampControllerCron.runRampController` and its `api.` twin,
 * with a `typeof` in front refused: that is the type-borrowing shape, and the
 * entry it names may have no caller at all. The lookbehind spans ANY run of
 * whitespace, so a `typeof` the formatter left at the end of a wrapped line —
 * or double-spaced — is refused the same as the one-space form.
 */
function generatedReference(module: string, name: string): RegExp {
	const dotted = module.replace(/\.ts$/, '').split('/').join('\\.');
	return new RegExp(`(?<!typeof\\s+)\\b(?:internal|api)\\.${dotted}\\.${name}\\b`);
}

/**
 * `'mail/imap:fetchEnvelopes'` — how a worker holding a `ConvexHttpClient`
 * addresses a function without the generated API object. Quoted on both ends, so
 * a docblock naming the same path in prose does not count (and comments are
 * stripped before this ever runs anyway).
 */
function workerReference(module: string, name: string): RegExp {
	return new RegExp(`'${module.replace(/\.ts$/, '')}:${name}'`);
}

/**
 * A value import wires an entry up only if the importing module then USES the
 * name as a value. `import { promoteCellPhase } …; type P = typeof
 * promoteCellPhase;` is `import type` one syntax over — it borrows a shape and
 * starts nothing — and the generated path already refuses that exact borrow, so
 * the import path refuses it too. The import statements themselves are cut
 * first, or the binding would count as its own use.
 */
function usedAsValue(source: string, name: string): boolean {
	return new RegExp(`(?<!typeof\\s+)(?<![\\w$.])${name}\\b`).test(source.replace(ANY_IMPORT, ''));
}

/**
 * Production modules that give `entry` a way in: a Convex module that addresses
 * it through the generated object (a cron registration is this shape) or imports
 * and uses it (an `http.ts` route handler is this shape), or a client module
 * that calls it on `api` or names its worker path. `entry`'s own module never
 * counts — `runRampController` self-schedules, and a seam that only calls itself
 * is still a seam nothing starts.
 */
function callersOf(
	entry: ConvexEntry,
	convexSources: ReadonlyMap<string, string>,
	clientSources: ReadonlyMap<string, string>
): string[] {
	const generated = generatedReference(entry.module, entry.name);
	const worker = workerReference(entry.module, entry.name);
	const callers: string[] = [];
	for (const [file, source] of convexSources) {
		if (file === entry.module) continue;
		if (generated.test(source) || worker.test(source)) {
			callers.push(file);
			continue;
		}
		const imported = [...source.matchAll(IMPORT_DECLARATION)]
			.filter((match) => resolveRelative(file, match[2] ?? '').includes(entry.module))
			.flatMap((match) => boundNames(match[1] ?? ''));
		if (imported.includes(entry.name) && usedAsValue(source, entry.name)) callers.push(file);
	}
	for (const [file, source] of clientSources) {
		if (generated.test(source) || worker.test(source)) callers.push(`client:${file}`);
	}
	return callers.sort();
}

function label(entry: ConvexEntry): string {
	return `${entry.module}#${entry.name}`;
}

/**
 * The walk, in two passes. Pass one is `callersOf`: cross-module references,
 * client calls, worker paths, cron registrations. Pass two answers the case
 * pass one is blind to by design: a module whose REACHED entry hands a SIBLING
 * entry of the same module to the scheduler — `completeSend` scheduling
 * `expireUnconfirmedAcceptance` two functions down is a live continuation, not
 * a door with no handle. Module code only executes through the module's own
 * entries, so a same-module reference is a way in exactly when some OTHER
 * entry of that module already has one; a module whose only reference to an
 * entry is that entry naming itself stays an orphan, which is the
 * self-schedule refusal `runRampController` pins below. Iterated to a fixed
 * point so a chain of same-module continuations resolves regardless of
 * declaration order.
 */
function reachedEntries(
	entries: readonly ConvexEntry[],
	convexSources: ReadonlyMap<string, string>,
	clientSources: ReadonlyMap<string, string>
): ReadonlySet<string> {
	const reached = new Set(
		entries.filter((entry) => callersOf(entry, convexSources, clientSources).length > 0).map(label)
	);
	let grew = true;
	while (grew) {
		grew = false;
		for (const entry of entries) {
			if (reached.has(label(entry))) continue;
			const source = convexSources.get(entry.module);
			if (source === undefined) continue;
			const referenced =
				generatedReference(entry.module, entry.name).test(source) ||
				workerReference(entry.module, entry.name).test(source);
			if (!referenced) continue;
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
 * THE LEDGER — every entry point in this backend that nothing can start, as of
 * the day the walk widened from `delivery/ramp*.ts` to all of `convex/` (#509).
 *
 * IT IS AN INVENTORY OF DEFECTS, NOT AN EXEMPTION LIST. Every line is a door
 * with no handle: an `internalMutation` no cron registers and no module calls, an
 * `authedQuery` no screen reads, an `internalQuery` whose only caller was deleted
 * with the feature that had it. The ramp's three were found one at a time by
 * reading diffs; there are 150 more, and the first honest thing to do with a
 * number that size is to write it down. (The walk's first draft counted 238:
 * 88 of those were same-module continuations — a reached entry handing a
 * sibling to the scheduler — which the sibling pass in `reachedEntries` now
 * credits, so they were never debt.) Each one is either wired up or deleted —
 * one PR at a time, not in the PR that discovered them.
 *
 * WHY A LEDGER AND NOT 150 DELETIONS HERE. A deletion is a behaviour claim about
 * the feature the entry belongs to, and 150 of them across every domain in the
 * backend is not a reviewable change; several of these are public `query`/
 * `mutation` surfaces where "no in-repo caller" is weaker evidence than it looks,
 * because a public function is an API an external client may hold. The ratchet is
 * what makes the list shrink: it is EXACT in both directions, exactly like
 * `scripts/check-convex-plugin-orphans.ts`'s `AWAITING_CALL_SITE` and
 * `scripts/file-size-baseline.txt`. A NEW orphan fails here — which is the whole
 * point, and the property `delivery/` did not have before today. A listed entry
 * that gains a caller, or that gets deleted, ALSO fails until its line comes off,
 * so the list cannot go quiet while the debt is paid down.
 *
 * Tracked in issue #528.
 */
const UNREACHED_ENTRIES: readonly string[] = [
	'agentHealth.ts#getCircuitBreakers',
	'analytics/llmUsage.ts#getSpendByPlugin',
	'analytics/qualityMetrics.ts#getClarifyMetrics',
	'analytics/qualityMetrics.ts#getDraftQualityMetrics',
	'analytics/reputationQueries.ts#getDomainReputations',
	'assistant/conversations.ts#getConversation',
	'auditLogs.ts#get',
	'auth/apiKeys.ts#countByTeam',
	'auth/apiKeys.ts#get',
	'auth/apiKeys.ts#revokeByPlugin',
	'automations/automations.ts#revertToDraft',
	'automations/triggers.ts#fireEventReceivedTrigger',
	'automations/triggers.ts#firePluginTrigger',
	'autonomyFeedback.ts#getRecentFeedback',
	'blockedEmails.ts#get',
	'blockedEmails.ts#isBlocked',
	'campaigns/analytics.ts#getActiveByOrganization',
	'campaigns/analytics.ts#getRecentlySentByOrganization',
	'campaigns/analytics.ts#getSendVolumeByDayByOrganization',
	'campaigns/analytics.ts#getTopPerformingByOrganization',
	'campaigns/audienceResolution.ts#resolveRecipients',
	'campaigns/campaigns.ts#get',
	'campaigns/organization.ts#getSentSummary',
	'chat/cleanup.ts#cleanupLegacyChatData',
	'connectedApps/hookDeliveryLogStore.ts#listHookDeliveryLogs',
	'connectedApps/hookRuntime.ts#invokeHook',
	'connectedApps/queries.ts#get',
	'contacts/activities.ts#countByContact',
	'contacts/contacts.ts#count',
	'contacts/contacts.ts#getAudienceStats',
	'contacts/identities.ts#ensureEmailIdentity',
	'contacts/identities.ts#findByIdentifier',
	'contacts/properties.ts#createDefaultProperties',
	'contacts/properties.ts#get',
	'contacts/properties.ts#getByKey',
	'contacts/propertyValues.ts#getByContactAndProperty',
	'contacts/propertyValues.ts#set',
	'contacts/relationships.ts#getGraph',
	'contacts/resolution.ts#resolve',
	'contacts/sunset.ts#listSunsetStage',
	'contacts/sunset.ts#restoreSunsetContact',
	'contacts/sunset.ts#setSunsetContactExemption',
	'contacts/sunset.ts#setSunsetPolicy',
	'delivery/alignmentPreflight.ts#getAlignmentGateState',
	'delivery/ipReadinessAlerts.ts#listRecent',
	'delivery/sends.ts#create',
	'delivery/sends.ts#listByCampaign',
	'delivery/sends.ts#listByContact',
	'delivery/suppressionMirror.ts#mirror',
	'domains/domains.ts#countByStatus',
	'domains/domains.ts#get',
	'domains/domains.ts#getByDomain',
	'domains/domains.ts#isDomainVerificationFresh',
	'domains/domains.ts#isDomainVerified',
	'domains/encryptionKeysReadiness.ts#checkEncryptionKeysReadiness',
	'e2ee/keys.ts#backfillKeys',
	'e2ee/keys.ts#getInstancePublicKey',
	'e2ee/keys.ts#getKeyForWkd',
	'e2ee/keys.ts#getPublicKeyByAddress',
	'e2ee/lifecycle.ts#revokeAddressKey',
	'e2ee/lifecycle.ts#rotateAddressKey',
	'e2ee/lifecycleNode.ts#runExportRecoveryKit',
	'e2ee/lifecycleNode.ts#runImportRecoveryKit',
	'e2ee/manifest.ts#getSignedManifest',
	'emailTemplates/emails.ts#changeType',
	'emailTemplates/emails.ts#publish',
	'emailTemplates/emails.ts#unpublish',
	'emailTemplates/organization.ts#createForOrganization',
	'forms/endpoints.ts#get',
	'forms/endpoints.ts#getForSubmission',
	'inbox/clarification.ts#answerClarification',
	'inbox/clarificationMemory.ts#listClarificationMemory',
	'inbox/clarificationMemory.ts#promoteClarificationMemory',
	'inbox/clarificationMemory.ts#revokeClarificationMemory',
	'inbox/mutations.ts#undoAutoSend',
	'knowledge/edgeBackfill.ts#cancel',
	'knowledge/edgeBackfill.ts#getStatus',
	'knowledge/graph.ts#createPolicyEntry',
	'knowledge/graph.ts#createRelation',
	'knowledge/graph.ts#listPolicies',
	'knowledge/graph.ts#setCommitmentStatus',
	'knowledge/graph.ts#updateConfidence',
	'knowledge/graphAnalytics.ts#getCrossContactLinks',
	'mail/ai.ts#summarizeThread',
	'mail/category.ts#backfill',
	'mail/commitments.ts#listCommitments',
	'mail/commitments.ts#resolveCommitment',
	'mail/dailyBrief.ts#getLatestBrief',
	'mail/externalAccountsActions.ts#connectSeed',
	'mail/externalAccountsSeed.ts#acknowledgeSeedRotation',
	'mail/folders.ts#list',
	'mail/mailbox.ts#inboxUnreadCount',
	'mail/mailbox.ts#latestInboxUnread',
	'mail/voiceProfile.ts#removeDerivedAdjustment',
	'mail/voiceProfile.ts#setStandingInstructions',
	'mediaAssets.ts#get',
	'mediaAssets.ts#remove',
	'platformAdmin/platformAdmin.ts#seedPlatformAdmin',
	'platformAdmin/queries.ts#getAdminAuditLog',
	'platformAdmin/queries.ts#getBillingOverview',
	'platformAdmin/queries.ts#getDeliveryStats',
	'platformAdmin/queries.ts#listAllDomains',
	'plugins/draftStrategySelections.ts#listCatalog',
	'plugins/draftStrategySelections.ts#setSelection',
	'plugins/importProviderAuthorization.ts#authorizeStart',
	'plugins/importProviderAuthorization.ts#recordOutcome',
	'plugins/webhookEventAuthorization.ts#authorizePublish',
	'plugins/webhookEventAuthorization.ts#recordOutcome',
	'plugins/workerTasks.ts#enqueue',
	'plugins/workerTasks.ts#listRecent',
	'plugins/workerTasks.ts#requestCancel',
	'storage.ts#deleteFile',
	'systemHealth.ts#getHealthStats',
	'topics/topics.ts#reorder',
	'transactional/emails.ts#getBySlug',
	'transactional/sends.ts#getByEmail',
	'transactional/sends.ts#listAll',
	'unifiedMessages.ts#getChannelConfig',
	'visualizationAgent.ts#get',
	'webhooks/endpoints.ts#countByOrganization',
	'webhooks/endpoints.ts#disable',
	'webhooks/endpoints.ts#enable',
	'webhooks/endpoints.ts#get',
	'webhooks/endpoints.ts#listDeliveryLogsByOrganization',
];

describe('the wiring guard is looking at production', () => {
	it('walked both sides and skipped their tests', () => {
		expect(CONVEX_SOURCES.size).toBeGreaterThan(500);
		expect(CLIENT_SOURCES.size).toBeGreaterThan(500);
		// Filtered, not `not.toContain(expect.stringContaining(…))`: `toContain`
		// compares by identity, so the negated asymmetric matcher passes on any
		// input and the excluded-tests premise would go unpinned.
		expect(
			[...CONVEX_SOURCES.keys(), ...CLIENT_SOURCES.keys()].filter(
				(file) => file.includes('__tests__') || file.endsWith('.test.ts')
			)
		).toEqual([]);
		// The two registration files the cron route depends on: drop either from the
		// walk and every cron-only entry below would fail for the wrong reason.
		expect([...CONVEX_SOURCES.keys()]).toContain('crons.ts');
		expect([...CONVEX_SOURCES.keys()]).toContain('delivery/cronRegistration.ts');
		// One client of each kind the walk learned about, so a root that stops being
		// searched fails here rather than turning every entry it reached into a
		// ledger line: the Nuxt app, a Nuxt server route, and an out-of-process
		// worker that addresses functions by string path.
		expect([...CLIENT_SOURCES.keys()]).toContain(
			'apps/web/app/pages/dashboard/admin/delivery/advanced/controls.vue'
		);
		expect([...CLIENT_SOURCES.keys()]).toContain('apps/web/server/api/system/update.post.ts');
		expect([...CLIENT_SOURCES.keys()]).toContain('apps/mail-sync/src/convex.ts');
	});

	it('knows every builder this backend declares an entry point with', () => {
		// Read from source, asserted exactly: a builder that ships without landing
		// here means the derivation stopped seeing one of the declaration shapes,
		// and the walk would go on treating exports wrapped in the missing builder
		// as ordinary helpers. A genuinely new builder belongs on this list.
		expect(ENTRY_BUILDERS).toEqual([
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
			'providerFeedbackWebhook',
			'publicAction',
			'publicMutation',
			'publicQuery',
			'publicTokenEndpoint',
			'query',
		]);
	});

	it('classifies every wrapped export the backend declares', () => {
		// The backstop under the builder list: an export wrapped in a call this file
		// knows nothing about is invisible to discovery, so it fails here instead.
		// Dotted callees (`v.object(`, `Object.freeze(`) are not candidates — a
		// Convex builder is always a bare identifier — which is why `EXPORTED_CALL`
		// refuses a dot rather than this list carrying thirty validator names.
		const unclassified = [...CONVEX_SOURCES.entries()].flatMap(([module, source]) =>
			[...source.matchAll(EXPORTED_CALL)]
				.filter(
					(match) =>
						!ENTRY_BUILDERS.includes(match[2] ?? '') && !((match[2] ?? '') in NOT_ENTRY_BUILDERS)
				)
				.map((match) => `${module}#${match[1]} = ${match[2]}(`)
		);
		expect(
			unclassified,
			'an export is wrapped in a call this walk cannot classify — it joins ENTRY_BUILDERS if it builds a Convex function, or NOT_ENTRY_BUILDERS with the reason it is no door'
		).toEqual([]);
	});

	it('gives every non-door wrapper a reason', () => {
		for (const [wrapper, reason] of Object.entries(NOT_ENTRY_BUILDERS)) {
			expect(reason.length, wrapper).toBeGreaterThan(20);
			expect(ENTRY_BUILDERS, wrapper).not.toContain(wrapper);
		}
		for (const [prefix, reason] of Object.entries(HAND_RUN_PREFIXES)) {
			expect(reason.length, prefix).toBeGreaterThan(20);
		}
	});

	it('refuses the export shapes discovery cannot anchor on', () => {
		const indirect = [...CONVEX_SOURCES.entries()].flatMap(([module, source]) =>
			indirectEntryExports(module, source)
		);
		expect(
			indirect,
			'a module puts a Convex function on its surface with `export { … }` or `export default` — an entry declared that way is registered by Convex and invisible to this walk, so declare it as `export const <name> = <builder>(` instead'
		).toEqual([]);
	});

	it('found the entry points, not the helpers around them', () => {
		// A floor, not an exact list: this backend has ~1,500 entry points and an
		// exact roster would be a merge conflict on every feature branch. The
		// exactness that matters is one level down — the BUILDER set above is exact,
		// so discovery cannot quietly stop seeing a declaration SHAPE, and the
		// ledger below is exact, so it cannot quietly stop seeing an ORPHAN.
		expect(CONVEX_ENTRIES.length).toBeGreaterThan(1_400);
		expect(CONVEX_ENTRIES.map(label)).toContain('delivery/rampControllerCron.ts#runRampController');
		expect(CONVEX_ENTRIES.map(label)).toContain('delivery/rampControls.ts#setCellPause');
		// `applyRampPhasePromotion` is the shared RULE, not an entry: it is reached
		// through a door, and a plain exported function is not addressable from a
		// cron or a client at all.
		expect(CONVEX_ENTRIES.map((entry) => entry.name)).not.toContain('applyRampPhasePromotion');
	});

	it('credits nothing to an entry name production never spells', () => {
		// The two D20 removals this guard is the memorial for.
		expect(
			callersOf(
				{ module: 'delivery/rampControllerCron.ts', name: 'promoteRampPhase' },
				CONVEX_SOURCES,
				CLIENT_SOURCES
			)
		).toEqual([]);
		expect(
			callersOf(
				{ module: 'delivery/snds.ts', name: 'getMicrosoftGateInput' },
				CONVEX_SOURCES,
				CLIENT_SOURCES
			)
		).toEqual([]);
	});
});

/**
 * DISCOVERY'S OWN PIN. Reachability is only ever asked about entries the walk
 * FOUND, so a declaration shape it cannot read is an orphan the suite reports as
 * green — the failure mode this file is built to refuse, one level up.
 */
describe('discovery reads the declaration shapes this repo writes', () => {
	it('finds the declaration the formatter wrapped after the `=`', () => {
		expect(
			entriesIn(
				'delivery/rampControls.ts',
				'export const orphanWrapped =\n\tinternalMutation({ args: {}, handler: async () => null });'
			)
		).toEqual([{ module: 'delivery/rampControls.ts', name: 'orphanWrapped' }]);
	});

	it('finds the declaration built with a wrapper builder, not just a generated one', () => {
		expect(
			entriesIn('delivery/rampGated.ts', 'export const gatedDoor = chatMutation({});')
		).toEqual([{ module: 'delivery/rampGated.ts', name: 'gatedDoor' }]);
	});

	it('finds the declaration built with a FACTORY that returns a builder', () => {
		// `contacts/api.ts` is a whole module of these, registered in `http.ts`.
		expect(
			entriesIn(
				'contacts/api.ts',
				'export const getContact = createAuthenticatedHandler(async () => {'
			)
		).toEqual([{ module: 'contacts/api.ts', name: 'getContact' }]);
	});

	it('finds nothing in an export wrapped in something that is not a builder', () => {
		expect(
			entriesIn('delivery/rampControls.ts', 'export const RAMP_LIMITS = Object.freeze({});')
		).toEqual([]);
	});

	it('reports the entry exported through a clause, which it cannot read', () => {
		const source = [
			'const orphanBraced = internalMutation({ args: {}, handler: async () => null });',
			'export { orphanBraced };',
		].join('\n');
		// Convex registers this as `internal.delivery.rampControls.orphanBraced`.
		// Discovery misses it and so does the unclassified-wrapper backstop — both
		// anchor on `export const` — so the export shape is what fails.
		expect(entriesIn('delivery/rampControls.ts', source)).toEqual([]);
		expect(indirectEntryExports('delivery/rampControls.ts', source)).toEqual([
			'delivery/rampControls.ts#orphanBraced (export { … })',
		]);
	});

	it('reports the entry exported as the default, which it cannot read either', () => {
		const source = 'export default internalMutation({ args: {}, handler: async () => null });';
		expect(entriesIn('delivery/rampControls.ts', source)).toEqual([]);
		expect(indirectEntryExports('delivery/rampControls.ts', source)).toEqual([
			'delivery/rampControls.ts#default (export default)',
		]);
	});

	it('leaves the export shapes this backend legitimately writes alone', () => {
		// The refusal is a rule about a HIDDEN DOOR, not about the words `export
		// default` or `export {`: the magic root files must default-export the value
		// the Convex CLI reads, and a barrel re-exporting helpers is house idiom.
		expect(indirectEntryExports('crons.ts', 'export default crons;')).toEqual([]);
		expect(indirectEntryExports('schema.ts', 'export default defineSchema({});')).toEqual([]);
		expect(
			indirectEntryExports(
				'domains/spf.ts',
				'const parsePoolIps = (raw) => raw;\nexport { parsePoolIps };'
			)
		).toEqual([]);
		expect(
			indirectEntryExports(
				'delivery/rampControls.ts',
				'export const setCellPause = adminMutation({});'
			)
		).toEqual([]);
	});
});

/**
 * THE GUARD'S OWN PIN. A reachability check that cannot fail is the defect it
 * exists to catch, so the walk is run over a fixture wired every way the repo
 * wires an entry — plus the orphan, mentioned in prose and borrowed as a type,
 * which is the exact shape `promoteRampPhase` had.
 */
describe('the walk fails an entry nothing can start', () => {
	const CRONNED = { module: 'delivery/rampSweep.ts', name: 'sweepRamp' } as const;
	const CALLED = { module: 'delivery/rampWrites.ts', name: 'applyRampWrite' } as const;
	const CLIENT = { module: 'delivery/rampDoor.ts', name: 'openRampDoor' } as const;
	const WORKER = { module: 'mail/imap.ts', name: 'fetchEnvelopes' } as const;
	const ORPHAN = { module: 'delivery/rampOrphan.ts', name: 'promoteOrphan' } as const;

	const convex: ReadonlyMap<string, string> = new Map(
		[
			[CRONNED.module, 'export const sweepRamp = internalMutation({});'],
			[CALLED.module, 'export const applyRampWrite = internalMutation({});'],
			[CLIENT.module, 'export const openRampDoor = adminMutation({});'],
			[WORKER.module, 'export const fetchEnvelopes = internalAction({});'],
			[
				ORPHAN.module,
				[
					'export const promoteOrphan = internalMutation({});',
					// Self-reference: the orphan naming itself must credit nothing.
					'internal.delivery.rampOrphan.promoteOrphan;',
				].join('\n'),
			],
			[
				'delivery/cronRegistration.ts',
				[
					// A TRAILING comment naming the orphan, on a line whose CODE
					// registers a different entry: strip `//` at line starts only and
					// this credits the orphan while the real registration still counts.
					"crons.hourly('sweep ramp', {}, internal.delivery.rampSweep.sweepRamp, {}); // supersedes internal.delivery.rampOrphan.promoteOrphan",
					// PROSE naming the orphan — the shape half a dozen ramp docblocks
					// have, and the one a bare grep would pass.
					'// See also internal.delivery.rampOrphan.promoteOrphan, which nothing runs.',
				].join('\n'),
			],
			[
				'delivery/rampControllerCron.ts',
				[
					"import { applyRampWrite } from './rampWrites';",
					// A TYPE-ONLY import of the orphan: it names the module and wires
					// nothing.
					"import type { OrphanResult } from './rampOrphan';",
					// And a VALUE import of the orphan consumed only in TYPE position —
					// `import type` one syntax over, past both the `import type` skip and
					// the inline-`type` specifier filter.
					"import { promoteOrphan } from './rampOrphan';",
					'type Promotion = typeof promoteOrphan;',
					'await applyRampWrite();',
				].join('\n'),
			],
		].map(([file, source]) => [file as string, stripComments(source as string)])
	);

	const clients: ReadonlyMap<string, string> = new Map(
		[
			[
				'apps/web/app/pages/dashboard/admin/delivery/advanced/controls.vue',
				// An HTML comment naming the orphan, in the file that holds the real
				// operator door: this is how a `.vue` template retires a control, and
				// the client half of the walk is largely `.vue`.
				[
					'<!-- superseded: api.delivery.rampOrphan.promoteOrphan -->',
					'useBackendOperation(api.delivery.rampDoor.openRampDoor);',
				].join('\n'),
			],
			[
				'apps/web/app/utils/deliverabilityRamp.ts',
				// The TYPE position: borrows the orphan's return type, calls nothing.
				// WRAPPED, with the `typeof` left on the previous line — the shape a
				// long entry path takes once the formatter breaks it, and the one a
				// single-whitespace lookbehind would credit as a real caller.
				[
					'type Outstanding = FunctionReturnType<',
					'\ttypeof',
					'\t\tapi.delivery.rampOrphan.promoteOrphan',
					'>;',
				].join('\n'),
			],
			[
				'apps/mail-sync/src/convex.ts',
				// The worker route: a string path, not the generated object. The
				// orphan's path appears too — UNQUOTED, the way a docblock spells it —
				// and must credit nothing.
				[
					"\tfetchEnvelopes: 'mail/imap:fetchEnvelopes' as FnRef,",
					'\t// replaces delivery/rampOrphan:promoteOrphan',
				].join('\n'),
			],
		].map(([file, source]) => [file as string, stripComments(source as string)])
	);

	it('credits the entry a cron registers', () => {
		expect(callersOf(CRONNED, convex, clients)).toEqual(['delivery/cronRegistration.ts']);
	});

	it('credits the entry another production module imports and calls', () => {
		expect(callersOf(CALLED, convex, clients)).toEqual(['delivery/rampControllerCron.ts']);
	});

	it('credits the entry the web client calls on api', () => {
		expect(callersOf(CLIENT, convex, clients)).toEqual([
			'client:apps/web/app/pages/dashboard/admin/delivery/advanced/controls.vue',
		]);
	});

	it('credits the entry an out-of-process worker addresses by string path', () => {
		expect(callersOf(WORKER, convex, clients)).toEqual(['client:apps/mail-sync/src/convex.ts']);
	});

	it('fails the orphan that only prose, an HTML comment, a type import, a typeof and an unquoted worker path mention', () => {
		expect(callersOf(ORPHAN, convex, clients)).toEqual([]);
	});

	it('credits that same value import once the module uses the name as a value', () => {
		// The pair that keeps the `typeof` refusal from turning the import branch
		// off: one `typeof` away from the case above, and it counts — this is the
		// shape `http.ts` registers a route handler in.
		const rewired = new Map(convex);
		rewired.set(
			'delivery/rampControllerCron.ts',
			stripComments(
				[
					"import { applyRampWrite } from './rampWrites';",
					"import { promoteOrphan } from './rampOrphan';",
					"http.route({ path: '/promote', handler: promoteOrphan });",
					'await applyRampWrite();',
				].join('\n')
			)
		);
		expect(callersOf(ORPHAN, rewired, clients)).toEqual(['delivery/rampControllerCron.ts']);
	});

	it('credits an index-module import, which is how http.ts reaches one route handler', () => {
		const rewired = new Map(convex);
		rewired.set('seedDemo/index.ts', 'export const seedDemoHttp = httpAction(async () => null);');
		rewired.set(
			'http.ts',
			stripComments(
				[
					"import { seedDemoHttp } from './seedDemo';",
					"http.route({ path: '/seed', handler: seedDemoHttp });",
				].join('\n')
			)
		);
		expect(
			callersOf({ module: 'seedDemo/index.ts', name: 'seedDemoHttp' }, rewired, clients)
		).toEqual(['http.ts']);
	});

	it('passes the same orphan once a cron registers it', () => {
		const rewired = new Map(convex);
		rewired.set(
			'delivery/cronRegistration.ts',
			"crons.hourly('promote', {}, internal.delivery.rampOrphan.promoteOrphan, {});"
		);
		expect(callersOf(ORPHAN, rewired, clients)).toEqual(['delivery/cronRegistration.ts']);
	});

	it('credits the sibling a reached entry schedules, and still fails the lone self-scheduler', () => {
		// The `completeSend` shape: a cron-reached entry hands its module-mate to
		// the scheduler. File-granular `callersOf` cannot see it — the reference is
		// same-module — so the sibling pass is what must credit it, and the ORPHAN
		// (whose module's only reference to it is its own) is what the pass must
		// still refuse.
		const COMPLETE = { module: 'delivery/sendCompletion.ts', name: 'completeSend' } as const;
		const EXPIRE = {
			module: 'delivery/sendCompletion.ts',
			name: 'expireUnconfirmedAcceptance',
		} as const;
		const rewired = new Map(convex);
		rewired.set(
			COMPLETE.module,
			stripComments(
				[
					'export const completeSend = internalMutation({});',
					'await ctx.scheduler.runAfter(0, internal.delivery.sendCompletion.expireUnconfirmedAcceptance, {});',
					'export const expireUnconfirmedAcceptance = internalMutation({});',
				].join('\n')
			)
		);
		rewired.set(
			'delivery/cronRegistration.ts',
			stripComments(
				"crons.hourly('complete', {}, internal.delivery.sendCompletion.completeSend, {});"
			)
		);
		const reached = reachedEntries([COMPLETE, EXPIRE, ORPHAN], rewired, clients);
		expect(reached.has(label(COMPLETE))).toBe(true);
		expect(reached.has(label(EXPIRE))).toBe(true);
		expect(reached.has(label(ORPHAN))).toBe(false);
	});
});

describe('every Convex entry point is reachable, or on the ledger', () => {
	const reached = reachedEntries(CONVEX_ENTRIES, CONVEX_SOURCES, CLIENT_SOURCES);
	const unreached = CONVEX_ENTRIES.filter(
		(entry) => !isHandRun(entry.module) && !reached.has(label(entry))
	).map(label);

	it('has no entry point that is neither reachable nor written down', () => {
		expect(
			unreached.filter((entry) => !UNREACHED_ENTRIES.includes(entry)),
			'a Convex entry point has no cron registration, no production caller, no client call and no worker path — register it, call it, or delete it. Adding it to UNREACHED_ENTRIES is for pre-existing debt only.'
		).toEqual([]);
	});

	it('keeps the ledger honest in the other direction', () => {
		expect(
			UNREACHED_ENTRIES.filter((entry) => !unreached.includes(entry)),
			'a ledger entry is now reachable, or was deleted — take its line out of UNREACHED_ENTRIES so the debt count only goes down'
		).toEqual([]);
	});

	it('leaves the ramp — the reason this walk exists — with nothing on the ledger', () => {
		// The scope this guard shipped with, held exactly where it was: every entry
		// under `delivery/ramp*.ts` is registered, called or exported to a client,
		// and none of them is written off as debt.
		expect(UNREACHED_ENTRIES.filter((entry) => /^delivery\/ramp/.test(entry))).toEqual([]);
	});

	it('takes the hourly controller through its cron registration and not its own self-schedule', () => {
		// The one entry whose only non-test caller is a cron table. It also
		// self-schedules for the next slice, which is precisely the reference this
		// walk must not credit.
		expect(
			callersOf(
				{ module: 'delivery/rampControllerCron.ts', name: 'runRampController' },
				CONVEX_SOURCES,
				CLIENT_SOURCES
			)
		).toEqual(['delivery/cronRegistration.ts']);
	});
});
