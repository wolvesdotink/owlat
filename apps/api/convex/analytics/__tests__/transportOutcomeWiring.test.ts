/**
 * EVERY TRANSPORT OUTCOME EVENT HAS A PRODUCTION WRITER.
 *
 * Three counters in plan D5 shipped with readers and no emitter — `deferred`,
 * `unsubscribed` and their gates — and survived every per-layer review, because
 * a layer's own tests fabricate the layer below: a gate suite hands the gate
 * rows, a summarizer suite hands the summarizer buckets, and a writer suite
 * calls the writer directly. Nothing in that stack asks the one question that
 * would have caught it: does anything in PRODUCTION ever emit this event?
 *
 * So this suite reads the SOURCE, not fixtures. It builds the set of events
 * production code can emit and asserts it covers the vocabulary exactly, by two
 * routes, because emission happens both ways:
 *
 *   1. LITERALLY — `transportOutcomeEffect(ref, 'delivered', at)`;
 *   2. THROUGH THE TRANSITION MAPPER — `transportOutcomeEffect(ref, event, at)`
 *      where `event` came from `transportOutcomeEventForTransition`. That route
 *      is admitted only when a production module actually bridges the two, and
 *      it contributes exactly the mapper's range over its whole domain.
 *
 * Both routes are kept honest by a third assertion: the effect tag may be
 * spelled only by the union that declares it, so a new emitter cannot hand-build
 * the object and slip past the constructor this guard watches.
 *
 * And a call site is not a caller, so the walk goes ONE HOP FURTHER: every module
 * that emits must itself be named by another production module. A `deferred`
 * literal sitting in a function nothing calls is the same silence, one level up.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	transportOutcomeCounters,
	transportOutcomeEventForTransition,
	TRANSPORT_OUTCOME_EVENTS,
	ZERO_TRANSPORT_OUTCOME_TOTALS,
	type TransportOutcomeCounter,
} from '../transportOutcomeSummary';

const convexRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The module that declares the effect — the only one allowed to spell its tag. */
const EFFECT_DECLARATION = join(convexRoot, 'delivery', 'sendLifecycle', 'effects.ts');
/** The module that owns the transition→event mapping. */
const MAPPER_DECLARATION = join(convexRoot, 'analytics', 'transportOutcomeSummary.ts');

/**
 * PRODUCTION ONLY. `__tests__` is excluded because a test emitter is precisely
 * the fabricated input this guard exists to see past, and `_generated` because
 * codegen names every function without calling any of them.
 */
function productionModules(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === '__tests__' || entry.name === '_generated') continue;
			found.push(...productionModules(full));
			continue;
		}
		if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
	}
	return found.sort();
}

// Comments talk ABOUT the emitters — this file's subject matter is discussed at
// length in `transportOutcomes.ts` — so a prose mention must never count as a
// call site.
function sourceWithoutComments(file: string): string {
	return readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const MODULES = productionModules(convexRoot);
const SOURCES = new Map(MODULES.map((file) => [file, sourceWithoutComments(file)]));

const named = (file: string): string => relative(convexRoot, file);

/** `transportOutcomeEffect(<ref>, 'delivered', …)` — the event named outright. */
const LITERAL_EMISSION = /transportOutcomeEffect\(\s*[^,)]+,\s*'([a-z_]+)'/g;
/** `transportOutcomeEffect(<ref>, event, …)` — the event computed by the mapper. */
const COMPUTED_EMISSION = /transportOutcomeEffect\(\s*[^,)]+,\s*([A-Za-z_$][\w$]*)\s*,/g;

/** Production modules that emit `event` by naming it, keyed by event. */
const LITERAL_WRITERS = new Map<string, string[]>();
/**
 * Production modules that hand the emitter a COMPUTED event AND resolve it
 * through the transition mapper in the same module. Both halves are required:
 * a computed argument whose origin is not the mapper proves nothing about which
 * events can come out of it.
 */
const MAPPER_WRITERS: string[] = [];

for (const [file, source] of SOURCES) {
	for (const match of source.matchAll(LITERAL_EMISSION)) {
		const event = match[1];
		if (event === undefined) continue;
		LITERAL_WRITERS.set(event, [...(LITERAL_WRITERS.get(event) ?? []), named(file)]);
	}
	const computed = [...source.matchAll(COMPUTED_EMISSION)];
	if (computed.length > 0 && source.includes('transportOutcomeEventForTransition(')) {
		MAPPER_WRITERS.push(named(file));
	}
}

/**
 * The mapper's DOMAIN, read off its own signature rather than hand-listed: a
 * transition added to the union and forgotten here would shrink the range this
 * guard credits, which fails the suite instead of quietly narrowing it.
 */
function transitionDomain(): string[] {
	const signature = /transportOutcomeEventForTransition\(\s*to:\s*([^,]+),/.exec(
		sourceWithoutComments(MAPPER_DECLARATION)
	);
	return (signature?.[1] ?? '')
		.split('|')
		.map((literal) => literal.trim().replace(/^'|'$/g, ''))
		.filter((literal) => literal.length > 0);
}

const TRANSITIONS = transitionDomain();

/** Every event the mapper can produce, over its whole domain. */
const MAPPER_RANGE = new Set<string>();
for (const to of TRANSITIONS) {
	for (const bounceType of [undefined, 'hard', 'soft'] as const) {
		const event = transportOutcomeEventForTransition(
			to as Parameters<typeof transportOutcomeEventForTransition>[0],
			bounceType
		);
		if (event !== null) MAPPER_RANGE.add(event);
	}
}

/** The production modules that can emit `event`, by either route. */
function writersFor(event: string): string[] {
	return [
		...(LITERAL_WRITERS.get(event) ?? []),
		...(MAPPER_RANGE.has(event) ? MAPPER_WRITERS : []),
	];
}

// ─── One hop further: the emitter itself must be REACHED ────────────────────

/**
 * A CALL SITE IS NOT A CALLER. Everything above answers "does production spell
 * this event anywhere", which is one level short of the failure it was written
 * for: delete the `recordDeferralOutcome` call out of `completeSend` and the
 * literal inside `deferralOutcome.ts` still satisfies `writersFor('deferred')`,
 * so the counter goes back to readers-with-no-writer with the guard green. Same
 * for `unsubscribed` and its scheduled entry point.
 *
 * So every emitting module must additionally be NAMED by some other production
 * module — imported, or addressed through the generated `internal`/`api` object,
 * which is how a scheduled emitter is called. That is one hop, deliberately: a
 * call-graph analyser would be a second implementation of the module system to
 * maintain, and a wired-then-unwired emitter is the shape that actually shipped.
 */

/** Convex-relative keys, so the walk is lexical and can be run over a fixture. */
const RELATIVE_SOURCES: ReadonlyMap<string, string> = new Map(
	[...SOURCES].map(([file, source]) => [named(file), source])
);

/** Modules that CONSTRUCT the effect — the emitters this guard follows. */
const EMITTERS = [...RELATIVE_SOURCES]
	.filter(
		([file, source]) =>
			file !== named(EFFECT_DECLARATION) && source.includes('transportOutcomeEffect(')
	)
	.map(([file]) => file)
	.sort();

/**
 * `import { a, b } from './x';` — clause and specifier. `import type` is skipped
 * whole: a module that needs only an emitter's RESULT TYPE has not wired it up,
 * and crediting that import is how a reachability check decays back into the
 * syntax check above.
 */
const IMPORT_DECLARATION = /^import\s+(?!type\b)([\s\S]*?)\s*from\s*'([^']+)';/gm;

/**
 * Names bound by a brace clause, inline `type` specifiers dropped. Both sides of
 * an `as` are kept — the imported name and the local one — because the caller
 * side wants one and the export side the other, and a miss here would fail the
 * suite for a rename rather than for a broken wire.
 */
function boundNames(clause: string): string[] {
	return clause
		.replace(/[{}]/g, ' ')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0 && !/^type\s/.test(entry))
		.flatMap((entry) => entry.split(/\s+as\s+/).map((part) => part.trim()))
		.filter((entry) => entry.length > 0);
}

/** What a module exports as a VALUE. `export type` is not one of them. */
function valueExports(source: string): Set<string> {
	const names = new Set<string>();
	const declared = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g;
	for (const match of source.matchAll(declared)) {
		if (match[1] !== undefined) names.add(match[1]);
	}
	// `export { a, b }` and its re-export form. `export type { … }` cannot match:
	// the brace has to follow `export` directly.
	for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const name of boundNames(match[1] ?? '')) names.add(name);
	}
	return names;
}

function resolveRelative(from: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null;
	return `${join(dirname(from), specifier)}.ts`;
}

/**
 * Production modules that name one of `emitter`'s value exports — by importing
 * it, or by addressing `internal.<module path>.<export>`.
 */
function productionReferrers(sources: ReadonlyMap<string, string>, emitter: string): string[] {
	const exported = valueExports(sources.get(emitter) ?? '');
	const dotted = emitter.replace(/\.ts$/, '').split('/').join('\\.');
	const generatedCall = new RegExp(`\\b(?:internal|api)\\.${dotted}\\.([A-Za-z_$][\\w$]*)`, 'g');
	const referrers: string[] = [];
	for (const [file, source] of sources) {
		if (file === emitter) continue;
		const mentioned: string[] = [];
		for (const match of source.matchAll(IMPORT_DECLARATION)) {
			if (resolveRelative(file, match[2] ?? '') !== emitter) continue;
			mentioned.push(...boundNames(match[1] ?? ''));
		}
		for (const match of source.matchAll(generatedCall)) {
			if (match[1] !== undefined) mentioned.push(match[1]);
		}
		if (mentioned.some((name) => exported.has(name))) referrers.push(file);
	}
	return referrers.sort();
}

describe('the wiring guard is looking at production', () => {
	it('walked the backend and skipped its tests', () => {
		expect(MODULES.length).toBeGreaterThan(100);
		expect(MODULES.filter((file) => named(file).includes('__tests__'))).toEqual([]);
		expect(MODULES.filter((file) => named(file).includes('_generated'))).toEqual([]);
		expect(MODULES).toContain(EFFECT_DECLARATION);
	});

	it('read the mapper domain off the signature, not off a hand-list', () => {
		// The empty-union failure mode: a renamed parameter would make the range
		// empty and credit no event to the mapper at all.
		expect(TRANSITIONS).toContain('bounced');
		expect(TRANSITIONS.length).toBeGreaterThanOrEqual(7);
		expect(MAPPER_RANGE.size).toBeGreaterThan(0);
	});

	it('credits nothing to an event no production site emits', () => {
		// The control: the extractors answer from the source, so a name the
		// vocabulary does not contain must come back with no writer at all.
		expect(writersFor('quarantined')).toEqual([]);
	});
});

describe('every transport outcome event has a production writer', () => {
	for (const event of TRANSPORT_OUTCOME_EVENTS) {
		it(`${event} is emitted somewhere outside a test`, () => {
			expect(writersFor(event)).not.toEqual([]);
		});
	}

	it('emits nothing outside the vocabulary', () => {
		const vocabulary: readonly string[] = TRANSPORT_OUTCOME_EVENTS;
		expect([...LITERAL_WRITERS.keys()].filter((event) => !vocabulary.includes(event))).toEqual([]);
	});

	it('takes the mapper range only through a module that bridges it', () => {
		// `soft_bounced`/`hard_bounced`/`complained` are never named at a call
		// site; they exist in production only because the accounting module feeds
		// the mapper's answer to the constructor. Lose that bridge and those three
		// counters are silently back to readers-with-no-writer.
		expect(MAPPER_WRITERS).not.toEqual([]);
		expect([...MAPPER_RANGE].sort()).toEqual([
			'complained',
			'hard_bounced',
			'sent',
			'soft_bounced',
		]);
	});
});

describe('the emission seam cannot be bypassed', () => {
	it('only the effect union spells the transport_outcome tag', () => {
		const spellers = MODULES.filter(
			(file) =>
				file !== EFFECT_DECLARATION && /kind:\s*'transport_outcome'/.test(SOURCES.get(file) ?? '')
		);
		expect(spellers.map(named)).toEqual([]);
	});

	it('the tag check is not vacuous — the declaring module does spell it', () => {
		expect(SOURCES.get(EFFECT_DECLARATION) ?? '').toMatch(/kind:\s*'transport_outcome'/);
	});
});

describe('every emitting module is reached from production', () => {
	it('found the emitters, and the declaring module is not one of them', () => {
		// The two the syntactic check cannot speak for: both emit outside the
		// lifecycle's own reducers, so both are exactly one deleted call away from
		// being a literal nothing runs.
		expect(EMITTERS).toContain('delivery/deferralOutcome.ts');
		expect(EMITTERS).toContain('delivery/unsubscribeOutcome.ts');
		expect(EMITTERS).not.toContain(named(EFFECT_DECLARATION));
	});

	for (const emitter of EMITTERS) {
		it(`${emitter} is named by another production module`, () => {
			expect(productionReferrers(RELATIVE_SOURCES, emitter)).not.toEqual([]);
		});
	}
});

/**
 * THE GUARD'S OWN PIN. A reachability check that cannot fail is the defect it
 * exists to catch, so the walk is run over a fixture whose emitters are wired
 * three different ways — imported, scheduled, and orphaned.
 */
describe('the reachability walk fails an emitter nothing calls', () => {
	const EMIT = "\tawait applyEffects(ctx, [transportOutcomeEffect(ref, 'deferred', at)]);";
	const IMPORTED = 'delivery/importedOutcome.ts';
	const SCHEDULED = 'delivery/scheduledOutcome.ts';
	const ORPHANED = 'delivery/orphanedOutcome.ts';

	const FIXTURE: ReadonlyMap<string, string> = new Map([
		[IMPORTED, `export async function recordImported() {\n${EMIT}\n}`],
		[SCHEDULED, `export const recordScheduled = internalMutation({});\n${EMIT}`],
		[
			ORPHANED,
			`export type OrphanedResult = 'observed';\nexport async function recordOrphaned() {\n${EMIT}\n}`,
		],
		[
			'delivery/sendCompletion.ts',
			[
				"import { recordImported } from './importedOutcome';",
				// The type-only import of the ORPHAN is the trap: it names the module
				// without wiring anything, and crediting it would pass the orphan.
				"import type { OrphanedResult } from './orphanedOutcome';",
				'await recordImported();',
			].join('\n'),
		],
		[
			'topics/subscription.ts',
			'await ctx.scheduler.runAfter(0, internal.delivery.scheduledOutcome.recordScheduled, {});',
		],
	]);

	it('credits the emitter its caller imports', () => {
		expect(productionReferrers(FIXTURE, IMPORTED)).toEqual(['delivery/sendCompletion.ts']);
	});

	it('credits the emitter a scheduler names through the generated api', () => {
		expect(productionReferrers(FIXTURE, SCHEDULED)).toEqual(['topics/subscription.ts']);
	});

	it('fails the emitter that only a type import mentions', () => {
		// The whole point, stated twice: the orphan satisfies the SYNTACTIC check
		// this suite already had — it names `deferred` at a call site — and fails
		// the reachability one, because nothing in production runs that call.
		const emitted = [...(FIXTURE.get(ORPHANED) ?? '').matchAll(LITERAL_EMISSION)].map(
			(match) => match[1]
		);
		expect(emitted).toEqual(['deferred']);
		expect(productionReferrers(FIXTURE, ORPHANED)).toEqual([]);
	});

	it('passes the same orphan once something calls it', () => {
		const rewired = new Map(FIXTURE);
		rewired.set(
			'delivery/sendCompletion.ts',
			`import { recordOrphaned } from './orphanedOutcome';\nawait recordOrphaned();`
		);
		expect(productionReferrers(rewired, ORPHANED)).toEqual(['delivery/sendCompletion.ts']);
	});
});

describe('every counter column is reachable from the vocabulary', () => {
	it('leaves no column that only a reader ever touches', () => {
		const bumped = new Set<TransportOutcomeCounter>();
		for (const event of TRANSPORT_OUTCOME_EVENTS) {
			for (const isCalibration of [false, true]) {
				for (const counter of transportOutcomeCounters(event, isCalibration)) bumped.add(counter);
			}
		}
		const columns = Object.keys(ZERO_TRANSPORT_OUTCOME_TOTALS) as TransportOutcomeCounter[];
		expect(columns.filter((column) => !bumped.has(column))).toEqual([]);
	});
});
