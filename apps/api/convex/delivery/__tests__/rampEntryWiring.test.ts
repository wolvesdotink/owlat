/**
 * EVERY RAMP ENTRY POINT HAS A WAY IN.
 *
 * Three separate ramp seams shipped with no caller and survived review, because
 * a Convex function's own suite calls it directly: `t.mutation(internal.…)` is
 * indistinguishable from production traffic to every assertion in the file. So
 * the suite is green, the function is correct, and nothing on the instance can
 * ever run it. `rampControllerCron.promoteRampPhase` was the third: an
 * internalMutation over the phase-promotion rule that no cron registered and no
 * module called, removed under D20 rather than given an invented caller.
 *
 * This guard reads the SOURCE, not fixtures. It collects every Convex function
 * exported from `delivery/ramp*.ts` and requires each one to be REACHED by one
 * of the three ways an entry point can be reached on this deployment:
 *
 *   1. a cron registers it — `internal.delivery.<module>.<name>` in
 *      `delivery/cronRegistration.ts` or `crons.ts`;
 *   2. another production Convex module calls it — addressed through the
 *      generated `internal`/`api` object (how a scheduled entry is called), or
 *      imported AND used as a value (how `http.ts` registers a route handler);
 *   3. the web client calls it — `api.delivery.<module>.<name>` in a production
 *      module under `apps/web`.
 *
 * All three collapse into one question — "does some production module NAME this
 * export" — so 1 and 2 share the walk; the cron route is pinned separately below
 * so that a registration file dropped out of the walk fails here rather than
 * quietly stops counting.
 *
 * DISCOVERY IS HALF THE GUARD. An entry the walk never finds is reported as
 * reachable by silence, which is the same outcome as having no guard at all, so
 * the collection side is pinned as hard as the reachability side: the builder
 * set is READ from `lib/authedFunctions.ts`, `_generated/server.d.ts` and the
 * `featureGated` wrappers rather than listed from memory (a builder added to the
 * backend joins the walk the day it ships), the declaration pattern accepts the
 * wrapped `const x =\n\tinternalMutation(` shape the formatter produces, the
 * discovered entry set is asserted EXACTLY rather than against a floor, and any
 * ramp export wrapped in a call this file cannot classify fails outright. The
 * anchor of all of it is `export const`, so the two shapes that put a Convex
 * function on a module's surface WITHOUT one — `export { name };` and `export
 * default` — are refused at the module surface: Convex registers both, and an
 * entry declared either way is a door neither discovery nor its backstop sees.
 *
 * WHY A TEST AND NOT A LINT SCRIPT: `scripts/check-convex-plugin-orphans.ts` is
 * the module-level cousin of this walk and covers `convex/plugins/` only. It
 * answers "is this MODULE reached", which a ramp module always is — every one of
 * them exports helpers the cron imports. The dead seam is one EXPORT inside a
 * live module, so the unit has to be the function.
 *
 * SCOPE. The walk covers `delivery/ramp*.ts`, the shell layer, and needs no
 * clause for the decision core beside it: `ramp/__tests__/gates.purity.test.ts`
 * refuses a Convex function wrapper in every module of `delivery/ramp/`, so no
 * entry point can be declared there to go unreached. The defect class is not
 * ramp-shaped, though — "a Convex entry point nothing on the instance can start"
 * is a `convex/`-wide property, and the two guards between them still leave a
 * nested `delivery/rampSomething/entry.ts` uncovered. Widening this walk to the
 * whole backend is tracked in issue #509, deliberately not done in the last wave
 * before the ship PR.
 *
 * TWO MENTIONS DO NOT COUNT, and both are shapes this repo actually contains:
 * a PROSE mention (`rampPhasePromotion.promoteCellPhase` is discussed in half a
 * dozen docblocks), and a TYPE position (`FunctionReturnType<typeof
 * api.delivery.rampEnrollment.enrollCell>` in `deliverabilityRamp.ts` names an
 * entry to borrow its return type and wires up nothing). Comments are stripped
 * in every syntax the walk crosses — both JavaScript ones on the backend, plus
 * the `<!-- -->` of the `.vue` templates that are most of the web half — and
 * `typeof` references are refused on the generated path AND on the import path,
 * which is the same borrow one syntax over. Otherwise the guard decays into a
 * grep for the function's own name, which every orphan passes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const convexRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = join(convexRoot, '..', '..', 'web');

/**
 * PRODUCTION ONLY. `__tests__` is excluded because a test caller is exactly the
 * fabricated way in this guard exists to see past, and `_generated` because
 * codegen names every function without calling any of them.
 */
function productionModules(dir: string, extensions: readonly string[]): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === '__tests__' || entry.name === '_generated') continue;
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
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
 * `<!-- -->` for the same reason one file type over: the web half of the walk is
 * almost entirely `.vue`, where an HTML comment is how a template is commented
 * out, so a superseded `api.delivery.…` line left in a template would credit the
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
const WEB_SOURCES = sourceMap(
	[
		...productionModules(join(webRoot, 'app'), ['.ts', '.vue']),
		...productionModules(join(webRoot, 'server'), ['.ts']),
	],
	webRoot
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
 * with it passes. So the names are collected from the three places this backend
 * makes a builder:
 *
 *   - `_generated/server.d.ts` — the codegen builders, `httpAction` included;
 *   - `lib/authedFunctions.ts` — every `export const` of it, because that module
 *     IS the builder module (a non-builder const added there widens discovery,
 *     which fails loud in the walk below, never silently narrows it);
 *   - `featureGated(<builder>, <flag>)` wrappers wherever they are declared —
 *     `chatMutation`, `assistantQuery` and their kin, exported or module-local.
 *
 * `publicTokenEndpoint` is named outright: it is an exported `function`, not a
 * const, and it produces the HTTP endpoints `http.ts` registers by imported
 * value. No ramp module declares one today; naming it keeps discovery from
 * missing the first one that does.
 */
const NAMED_BUILDERS = ['publicTokenEndpoint'] as const;

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

const ENTRY_BUILDERS: readonly string[] = [
	...new Set([...generatedBuilders(), ...wrapperBuilders(), ...NAMED_BUILDERS]),
].sort();

/**
 * Ramp exports wrapped in a call that is deliberately NOT an entry point. Empty
 * because no ramp module has one today; the walk fails on an unclassified
 * wrapper rather than assuming it, so this is the seam for the first one that
 * turns up (a frozen constant, a memoised helper) and the reason it is no door.
 */
const NOT_ENTRY_BUILDERS: readonly string[] = [];

/** The modules this guard is about: `delivery/ramp*.ts`, the shell layer. */
const RAMP_MODULES = [...CONVEX_SOURCES.keys()]
	.filter((file) => /^delivery\/ramp[^/]*\.ts$/.test(file))
	.sort();

/**
 * `\s*` around the `=` on purpose: the formatter wraps a long declaration onto
 * the line after it (`export const x =\n\tinternalMutation({…})`), a shape
 * `scripts/check-public-functions.sh` carries its own two-line awk pass for
 * because it occurs. A single-space pattern skips those declarations, and an
 * entry discovery never makes is reported reachable by silence.
 */
const ENTRY_DECLARATION = new RegExp(
	`export const ([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${ENTRY_BUILDERS.join('|')})\\s*\\(`,
	'g'
);

/** `export const x = someCall(` — the shape an entry declaration takes at all. */
const EXPORTED_CALL = /export const ([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*)\s*\(/g;

/**
 * `export { x };` and `export default …` — the two shapes that put a value on a
 * module's surface WITHOUT an `export const` for discovery (or its
 * unclassified-wrapper backstop, which is anchored the same way) to read.
 * Convex registers a function exported either way, so an entry declared like
 * that is a live door neither half of the walk can see.
 *
 * Refused at the module surface rather than parsed: `export { … }` is live house
 * idiom under `convex/` and re-exporting a Convex function is not, so the cheap
 * rule keeps discovery's single anchor honest. Widening discovery to read the
 * shapes is the alternative — do that, and this pin comes off with it.
 */
function indirectExports(module: string, source: string): string[] {
	return [...source.matchAll(/^export\s*(\{|default\b)/gm)].map(
		(match) => `${module}#export ${match[1] === 'default' ? 'default' : '{ … }'}`
	);
}

interface RampEntry {
	readonly module: string;
	readonly name: string;
}

function entriesIn(module: string, source: string): RampEntry[] {
	return [...source.matchAll(ENTRY_DECLARATION)].flatMap((match) =>
		match[1] === undefined ? [] : [{ module, name: match[1] }]
	);
}

const RAMP_ENTRIES: RampEntry[] = RAMP_MODULES.flatMap((module) =>
	entriesIn(module, CONVEX_SOURCES.get(module) ?? '')
);

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

function resolveRelative(from: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null;
	return `${join(dirname(from), specifier)}.ts`.split('\\').join('/');
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
 * it through the generated object (a cron registration is this shape) or
 * imports and uses it (an `http.ts` route handler is this shape), or a web
 * module that calls it on `api`. `entry`'s own module never counts —
 * `runRampController` self-schedules, and a seam that only calls itself is still
 * a seam nothing starts.
 */
function callersOf(
	entry: RampEntry,
	convexSources: ReadonlyMap<string, string>,
	webSources: ReadonlyMap<string, string>
): string[] {
	const reference = generatedReference(entry.module, entry.name);
	const callers: string[] = [];
	for (const [file, source] of convexSources) {
		if (file === entry.module) continue;
		if (reference.test(source)) {
			callers.push(file);
			continue;
		}
		const imported = [...source.matchAll(IMPORT_DECLARATION)]
			.filter((match) => resolveRelative(file, match[2] ?? '') === entry.module)
			.flatMap((match) => boundNames(match[1] ?? ''));
		if (imported.includes(entry.name) && usedAsValue(source, entry.name)) callers.push(file);
	}
	for (const [file, source] of webSources) {
		if (reference.test(source)) callers.push(`web:${file}`);
	}
	return callers.sort();
}

describe('the wiring guard is looking at production', () => {
	it('walked both sides and skipped their tests', () => {
		expect(CONVEX_SOURCES.size).toBeGreaterThan(100);
		expect(WEB_SOURCES.size).toBeGreaterThan(50);
		// Filtered, not `not.toContain(expect.stringContaining(…))`: `toContain`
		// compares by identity, so the negated asymmetric matcher passes on any
		// input and the excluded-tests premise would go unpinned.
		expect(
			[...CONVEX_SOURCES.keys(), ...WEB_SOURCES.keys()].filter(
				(file) => file.includes('__tests__') || file.endsWith('.test.ts')
			)
		).toEqual([]);
		// The two registration files the cron route depends on: drop either from the
		// walk and every cron-only entry below would fail for the wrong reason.
		expect([...CONVEX_SOURCES.keys()]).toContain('crons.ts');
		expect([...CONVEX_SOURCES.keys()]).toContain('delivery/cronRegistration.ts');
		// And the screen the operator doors hang off.
		expect([...WEB_SOURCES.keys()]).toContain('app/pages/dashboard/delivery/controls.vue');
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
			'httpAction',
			'internalAction',
			'internalMutation',
			'internalQuery',
			'mutation',
			'ownerMutation',
			'publicAction',
			'publicMutation',
			'publicQuery',
			'publicTokenEndpoint',
			'query',
		]);
	});

	it('classifies every wrapped export the ramp modules declare', () => {
		// The backstop under the builder list: an export wrapped in a call this file
		// knows nothing about is invisible to discovery, so it fails here instead.
		const unclassified = RAMP_MODULES.flatMap((module) =>
			[...(CONVEX_SOURCES.get(module) ?? '').matchAll(EXPORTED_CALL)]
				.filter(
					(match) =>
						!ENTRY_BUILDERS.includes(match[2] ?? '') && !NOT_ENTRY_BUILDERS.includes(match[2] ?? '')
				)
				.map((match) => `${module}#${match[1]} = ${match[2]}(`)
		);
		expect(
			unclassified,
			'a ramp export is wrapped in a call this walk cannot classify — add it to ENTRY_BUILDERS if it builds a Convex function, to NOT_ENTRY_BUILDERS with the reason it is no door otherwise'
		).toEqual([]);
	});

	it('refuses the export shapes discovery cannot anchor on', () => {
		const indirect = RAMP_MODULES.flatMap((module) =>
			indirectExports(module, CONVEX_SOURCES.get(module) ?? '')
		);
		expect(
			indirect,
			'a ramp module puts a value on its surface with `export { … }` or `export default` — an entry declared that way is registered by Convex and invisible to this walk, so declare it as `export const <name> = <builder>(` instead'
		).toEqual([]);
	});

	it('found the ramp entry points, not the helpers around them', () => {
		// Exact, not a floor: a floor keeps passing while discovery quietly stops
		// seeing an entry, which is the failure this whole file exists to prevent.
		// A new ramp entry point belongs on this list AND needs a way in below.
		expect(RAMP_ENTRIES.map((entry) => `${entry.module}#${entry.name}`).sort()).toEqual([
			'delivery/rampControlQueries.ts#getRampControls',
			'delivery/rampControlQueries.ts#listCellDecisions',
			'delivery/rampControlQueries.ts#listRampAdminNotices',
			'delivery/rampControllerCron.ts#runRampController',
			'delivery/rampControls.ts#forceAdvanceCellShare',
			'delivery/rampControls.ts#pinCellShare',
			'delivery/rampControls.ts#setCellPause',
			'delivery/rampControls.ts#setStreamPreset',
			'delivery/rampEnrollment.ts#enrollCell',
			'delivery/rampIndependence.ts#getIndependenceSummary',
			'delivery/rampMixDecisions.ts#cleanupExpiredDecisions',
			'delivery/rampPhasePromotion.ts#promoteCellPhase',
			'delivery/rampPhaseReset.ts#resetCellPhase',
		]);
		// `applyRampPhasePromotion` is the shared RULE, not an entry: it is reached
		// through a door, and a plain exported function is not addressable from a
		// cron or a client at all.
		expect(RAMP_ENTRIES.map((entry) => entry.name)).not.toContain('applyRampPhasePromotion');
	});

	it('credits nothing to an entry name production never spells', () => {
		expect(
			callersOf(
				{ module: 'delivery/rampControllerCron.ts', name: 'promoteRampPhase' },
				CONVEX_SOURCES,
				WEB_SOURCES
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
		// anchor on `export const` — so the module surface is what fails.
		expect(entriesIn('delivery/rampControls.ts', source)).toEqual([]);
		expect(indirectExports('delivery/rampControls.ts', source)).toEqual([
			'delivery/rampControls.ts#export { … }',
		]);
	});

	it('reports the entry exported as the default, which it cannot read either', () => {
		const source = 'export default internalMutation({ args: {}, handler: async () => null });';
		expect(entriesIn('delivery/rampControls.ts', source)).toEqual([]);
		expect(indirectExports('delivery/rampControls.ts', source)).toEqual([
			'delivery/rampControls.ts#export default',
		]);
	});

	it('leaves the declaration shape the ramp modules actually write alone', () => {
		// The refusal above is a rule about the module SURFACE, not about the word
		// `export`: the shape every ramp entry ships in still passes it.
		expect(
			indirectExports('delivery/rampControls.ts', 'export const setCellPause = adminMutation({});')
		).toEqual([]);
	});
});

/**
 * THE GUARD'S OWN PIN. A reachability check that cannot fail is the defect it
 * exists to catch, so the walk is run over a fixture wired every way the repo
 * wires an entry — plus the orphan, mentioned in prose and borrowed as a type,
 * which is the exact shape `promoteRampPhase` had.
 */
describe('the walk fails a ramp entry nothing can start', () => {
	const CRONNED = { module: 'delivery/rampSweep.ts', name: 'sweepRamp' } as const;
	const CALLED = { module: 'delivery/rampWrites.ts', name: 'applyRampWrite' } as const;
	const CLIENT = { module: 'delivery/rampDoor.ts', name: 'openRampDoor' } as const;
	const ORPHAN = { module: 'delivery/rampOrphan.ts', name: 'promoteOrphan' } as const;

	const convex: ReadonlyMap<string, string> = new Map(
		[
			[CRONNED.module, 'export const sweepRamp = internalMutation({});'],
			[CALLED.module, 'export const applyRampWrite = internalMutation({});'],
			[CLIENT.module, 'export const openRampDoor = adminMutation({});'],
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

	const web: ReadonlyMap<string, string> = new Map(
		[
			[
				'app/pages/dashboard/delivery/controls.vue',
				// An HTML comment naming the orphan, in the file that holds the real
				// operator door: this is how a `.vue` template retires a control, and
				// the web half of the walk is almost all `.vue`.
				[
					'<!-- superseded: api.delivery.rampOrphan.promoteOrphan -->',
					'useBackendOperation(api.delivery.rampDoor.openRampDoor);',
				].join('\n'),
			],
			[
				'app/utils/deliverabilityRamp.ts',
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
		].map(([file, source]) => [file as string, stripComments(source as string)])
	);

	it('credits the entry a cron registers', () => {
		expect(callersOf(CRONNED, convex, web)).toEqual(['delivery/cronRegistration.ts']);
	});

	it('credits the entry another production module imports and calls', () => {
		expect(callersOf(CALLED, convex, web)).toEqual(['delivery/rampControllerCron.ts']);
	});

	it('credits the entry the web client calls on api', () => {
		expect(callersOf(CLIENT, convex, web)).toEqual([
			'web:app/pages/dashboard/delivery/controls.vue',
		]);
	});

	it('fails the orphan that only prose, an HTML comment, a type import and a typeof mention', () => {
		expect(callersOf(ORPHAN, convex, web)).toEqual([]);
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
		expect(callersOf(ORPHAN, rewired, web)).toEqual(['delivery/rampControllerCron.ts']);
	});

	it('passes the same orphan once a cron registers it', () => {
		const rewired = new Map(convex);
		rewired.set(
			'delivery/cronRegistration.ts',
			"crons.hourly('promote', {}, internal.delivery.rampOrphan.promoteOrphan, {});"
		);
		expect(callersOf(ORPHAN, rewired, web)).toEqual(['delivery/cronRegistration.ts']);
	});
});

describe('every ramp entry point is reachable', () => {
	for (const entry of RAMP_ENTRIES) {
		it(`${entry.module}#${entry.name} is registered, called or exported to the client`, () => {
			expect(
				callersOf(entry, CONVEX_SOURCES, WEB_SOURCES),
				`${entry.module}#${entry.name} has no cron registration, no production caller and no client call — register it, call it, or delete it`
			).not.toEqual([]);
		});
	}

	it('takes the hourly controller through its cron registration and not its own self-schedule', () => {
		// The one entry whose only non-test caller is a cron table. It also
		// self-schedules for the next slice, which is precisely the reference this
		// walk must not credit.
		expect(
			callersOf(
				{ module: 'delivery/rampControllerCron.ts', name: 'runRampController' },
				CONVEX_SOURCES,
				WEB_SOURCES
			)
		).toEqual(['delivery/cronRegistration.ts']);
	});
});
