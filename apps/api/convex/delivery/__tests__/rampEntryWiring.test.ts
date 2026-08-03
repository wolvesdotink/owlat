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
 *   2. another production Convex module calls it — imported, or addressed
 *      through the generated `internal`/`api` object (how a scheduled entry is
 *      called);
 *   3. the web client calls it — `api.delivery.<module>.<name>` in a production
 *      module under `apps/web`.
 *
 * All three collapse into one question — "does some production module NAME this
 * export" — so 1 and 2 share the walk; the cron route is pinned separately below
 * so that a registration file dropped out of the walk fails here rather than
 * quietly stops counting.
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
 * and `typeof` references are refused, or the guard decays into a grep for the
 * function's own name — which every orphan passes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const convexRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webRoot = join(convexRoot, '..', '..', 'web');

/** The Convex builders. An export wrapped in anything else is not an entry. */
const ENTRY_BUILDERS = [
	'internalMutation',
	'internalQuery',
	'internalAction',
	'adminMutation',
	'adminQuery',
	'ownerMutation',
	'authedMutation',
	'authedQuery',
	'authedAction',
	'publicMutation',
	'publicQuery',
	'publicAction',
	'mutation',
	'query',
	'action',
] as const;

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
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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

/** The modules this guard is about: `delivery/ramp*.ts`, the shell layer. */
const RAMP_MODULES = [...CONVEX_SOURCES.keys()]
	.filter((file) => /^delivery\/ramp[^/]*\.ts$/.test(file))
	.sort();

const ENTRY_DECLARATION = new RegExp(
	`export const ([A-Za-z_$][\\w$]*) = (?:${ENTRY_BUILDERS.join('|')})\\(`,
	'g'
);

interface RampEntry {
	readonly module: string;
	readonly name: string;
}

const RAMP_ENTRIES: RampEntry[] = RAMP_MODULES.flatMap((module) =>
	[...(CONVEX_SOURCES.get(module) ?? '').matchAll(ENTRY_DECLARATION)].flatMap((match) =>
		match[1] === undefined ? [] : [{ module, name: match[1] }]
	)
);

/**
 * `import { a, b } from './x';` — clause and specifier. `import type` is skipped
 * whole: a module that borrows an entry's argument or result TYPE has not wired
 * it up, and crediting that is how a reachability check decays into a grep.
 */
const IMPORT_DECLARATION = /^import\s+(?!type\b)([\s\S]*?)\s*from\s*'([^']+)';/gm;

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
 * Production modules that give `entry` a way in: a Convex module that imports it
 * or addresses it through the generated object (a cron registration is this
 * shape), or a web module that calls it on `api`. `entry`'s own module never
 * counts — `runRampController` self-schedules, and a seam that only calls itself
 * is still a seam nothing starts.
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
		if (imported.includes(entry.name)) callers.push(file);
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

	it('found the ramp entry points, not the helpers around them', () => {
		const named = RAMP_ENTRIES.map((entry) => `${entry.module}#${entry.name}`);
		expect(named).toContain('delivery/rampControllerCron.ts#runRampController');
		expect(named).toContain('delivery/rampPhasePromotion.ts#promoteCellPhase');
		expect(named).toContain('delivery/rampEnrollment.ts#enrollCell');
		expect(named).toContain('delivery/rampControlQueries.ts#getRampControls');
		expect(named.length).toBeGreaterThanOrEqual(12);
		// `applyRampPhasePromotion` is the shared RULE, not an entry: it is reached
		// through a door, and a plain exported function is not addressable from a
		// cron or a client at all.
		expect(named).not.toContain('delivery/rampPhasePromotion.ts#applyRampPhasePromotion');
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
					'await applyRampWrite();',
				].join('\n'),
			],
		].map(([file, source]) => [file as string, stripComments(source as string)])
	);

	const web: ReadonlyMap<string, string> = new Map(
		[
			[
				'app/pages/dashboard/delivery/controls.vue',
				'useBackendOperation(api.delivery.rampDoor.openRampDoor);',
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

	it('credits the entry another production module imports', () => {
		expect(callersOf(CALLED, convex, web)).toEqual(['delivery/rampControllerCron.ts']);
	});

	it('credits the entry the web client calls on api', () => {
		expect(callersOf(CLIENT, convex, web)).toEqual([
			'web:app/pages/dashboard/delivery/controls.vue',
		]);
	});

	it('fails the orphan that only prose, a type import and itself mention', () => {
		expect(callersOf(ORPHAN, convex, web)).toEqual([]);
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
