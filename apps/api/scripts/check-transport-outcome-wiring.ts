/**
 * EVERY TRANSPORT OUTCOME EVENT HAS A PRODUCTION WRITER.
 *
 * Three counters in plan D5 shipped with readers and no emitter, because each
 * layer's tests fabricate the layer below. This reads the SOURCE and builds the
 * set of events production can emit, by two routes: literally
 * (`transportOutcomeEffect(ref, 'delivered', at)`) and through the transition
 * mapper (`transportOutcomeEffect(ref, event, at)` where `event` came from
 * `transportOutcomeEventForTransition`, admitted only in a module that bridges
 * the two). The effect tag may be spelled only by the union that declares it,
 * and every emitting module must itself be NAMED by another production module
 * — a literal in a function nothing calls is the same silence one level up.
 *
 * Run by `bun run lint` (apps/api): `bun scripts/check-transport-outcome-wiring.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
	transportOutcomeEventForTransition,
	TRANSPORT_OUTCOME_EVENTS,
} from '../convex/analytics/transportOutcomeSummary';

const convexRoot = join(import.meta.dirname, '..', 'convex');
const EFFECT_DECLARATION = join(convexRoot, 'delivery', 'sendLifecycle', 'effects.ts');
const MAPPER_DECLARATION = join(convexRoot, 'analytics', 'transportOutcomeSummary.ts');

const failures: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}

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

function sourceWithoutComments(file: string): string {
	return readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const MODULES = productionModules(convexRoot);
const SOURCES = new Map(MODULES.map((file) => [file, sourceWithoutComments(file)]));
const named = (file: string): string => relative(convexRoot, file);

const LITERAL_EMISSION = /transportOutcomeEffect\(\s*[^,)]+,\s*'([a-z_]+)'/g;
const COMPUTED_EMISSION = /transportOutcomeEffect\(\s*[^,)]+,\s*([A-Za-z_$][\w$]*)\s*,/g;

const LITERAL_WRITERS = new Map<string, string[]>();
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

// The mapper's domain, read off its own signature rather than hand-listed.
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

const writersFor = (event: string): string[] => [
	...(LITERAL_WRITERS.get(event) ?? []),
	...(MAPPER_RANGE.has(event) ? MAPPER_WRITERS : []),
];

// ─── One hop further: the emitter itself must be reached ────────────────────

const RELATIVE_SOURCES: ReadonlyMap<string, string> = new Map(
	[...SOURCES].map(([file, source]) => [named(file), source])
);

const EMITTERS = [...RELATIVE_SOURCES]
	.filter(
		([file, source]) =>
			file !== named(EFFECT_DECLARATION) && source.includes('transportOutcomeEffect(')
	)
	.map(([file]) => file)
	.sort();

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

function valueExports(source: string): Set<string> {
	const names = new Set<string>();
	const declared = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g;
	for (const match of source.matchAll(declared)) {
		if (match[1] !== undefined) names.add(match[1]);
	}
	for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const name of boundNames(match[1] ?? '')) names.add(name);
	}
	return names;
}

const resolveRelative = (from: string, specifier: string): string | null =>
	specifier.startsWith('.') ? `${join(dirname(from), specifier)}.ts` : null;

// Production modules that name one of `emitter`'s value exports — by importing
// it, or by addressing `internal.<module path>.<export>`.
function productionReferrers(emitter: string): string[] {
	const exported = valueExports(RELATIVE_SOURCES.get(emitter) ?? '');
	const dotted = emitter.replace(/\.ts$/, '').split('/').join('\\.');
	const generatedCall = new RegExp(`\\b(?:internal|api)\\.${dotted}\\.([A-Za-z_$][\\w$]*)`, 'g');
	const referrers: string[] = [];
	for (const [file, source] of RELATIVE_SOURCES) {
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

// ─── The checks ─────────────────────────────────────────────────────────────

check(MODULES.length > 100, `walked only ${MODULES.length} modules`);
check(SOURCES.has(EFFECT_DECLARATION), 'the effect declaration module dropped out of the walk');
check(
	TRANSITIONS.includes('bounced') && TRANSITIONS.length >= 7,
	'could not read the mapper domain off transportOutcomeEventForTransition'
);
check(MAPPER_RANGE.size > 0, 'the mapper range is empty');
check(
	writersFor('quarantined').length === 0,
	'the extractors credit a writer to an event outside the vocabulary'
);

for (const event of TRANSPORT_OUTCOME_EVENTS) {
	check(
		writersFor(event).length > 0,
		`${event} is a transport outcome event no production module emits`
	);
}
const vocabulary: readonly string[] = TRANSPORT_OUTCOME_EVENTS;
for (const event of LITERAL_WRITERS.keys()) {
	check(vocabulary.includes(event), `${event} is emitted but is not in TRANSPORT_OUTCOME_EVENTS`);
}
check(
	MAPPER_WRITERS.length > 0,
	'no production module bridges the transition mapper to the effect constructor'
);
check(
	JSON.stringify([...MAPPER_RANGE].sort()) ===
		JSON.stringify(['complained', 'hard_bounced', 'sent', 'soft_bounced']),
	`the mapper range changed: ${[...MAPPER_RANGE].sort().join(', ')}`
);

const spellers = MODULES.filter(
	(file) =>
		file !== EFFECT_DECLARATION && /kind:\s*'transport_outcome'/.test(SOURCES.get(file) ?? '')
).map(named);
check(
	spellers.length === 0,
	`only the effect union may spell the transport_outcome tag; also spelled by ${spellers.join(', ')}`
);
check(
	/kind:\s*'transport_outcome'/.test(SOURCES.get(EFFECT_DECLARATION) ?? ''),
	'the declaring module no longer spells the tag — the check is vacuous'
);

for (const landmark of ['delivery/deferralOutcome.ts', 'delivery/unsubscribeOutcome.ts']) {
	check(EMITTERS.includes(landmark), `${landmark} is no longer an emitter`);
}
for (const emitter of EMITTERS) {
	check(
		productionReferrers(emitter).length > 0,
		`${emitter} emits a transport outcome but no production module names it`
	);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log(
	`check-transport-outcome-wiring: OK (${TRANSPORT_OUTCOME_EVENTS.length} events, ${EMITTERS.length} emitters)`
);
