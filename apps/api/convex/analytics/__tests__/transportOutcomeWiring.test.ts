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
