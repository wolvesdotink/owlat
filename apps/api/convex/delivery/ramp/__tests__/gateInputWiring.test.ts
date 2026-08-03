/**
 * EVERY GATE INPUT HAS A PRODUCTION SUPPLIER.
 *
 * The sibling of `analytics/__tests__/transportOutcomeWiring.test.ts`, applied
 * one layer up. That guard asks whether anything in production EMITS each
 * transport outcome event; this one asks whether anything in production SETS
 * each field of `RampGateEvaluationInput` — the other half of the same defect,
 * and the one that shipped: `ownSeeds` and `referenceSeeds` were declared, read
 * by gate 5 and set by nobody, so the gate returned `insufficient_data` for
 * every cell of every deployment and no suite anywhere noticed. A gate suite
 * hands the gate an input; only the SOURCE knows whether a caller builds one.
 *
 * So this reads the source, twice over, and never a fixture:
 *
 *   1. THE FIELDS come off the interface declaration in `gateTypes.ts`, so a
 *      field added there is covered the day it lands rather than the day
 *      somebody remembers this file.
 *   2. THE SUPPLIERS come off the object literals production modules pass to
 *      `.evaluate(...)`, so a field that only a test ever sets has no supplier
 *      here, which is exactly the state this guard exists to name.
 *
 * A gap is allowed to EXIST — some evidence genuinely has no reader yet — but
 * only by being written down below, which makes it a tracked absence instead of
 * a silent one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const convexRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE_TYPES = join(convexRoot, 'delivery', 'ramp', 'gateTypes.ts');

/**
 * THE FIELDS WITH NO PRODUCTION SUPPLIER TODAY, each with the reason it has
 * none. Asserted EXACTLY, not as a floor: closing a gap without deleting its
 * line here fails this suite, so the list can only ever shrink.
 *
 * `smtpBlocks` — the SMTP response classifier runs in the MTA
 * (`apps/mta/src/.../classifySmtpResponse`) and nothing carries its per-category
 * counts into Convex, so no reader can build the observation gate 1b's block
 * clause consumes. Wiring it is a transport-telemetry surface of its own, not a
 * line in a controller; tracked separately rather than faked with a zeroed
 * observation, which would read as "we measured no blocks" instead of "we did
 * not measure".
 */
const KNOWN_UNSUPPLIED: readonly string[] = ['smtpBlocks'];

/**
 * PRODUCTION ONLY — `__tests__` is the fabricated caller this guard exists to
 * see past, and `_generated` names every function without calling any of them.
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

/** Comments discuss these fields at length; only code may count as a supplier. */
function sourceWithoutComments(file: string): string {
	return readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

const MODULES = productionModules(convexRoot);
const named = (file: string): string => relative(convexRoot, file);

/**
 * The declared fields, read off the interface rather than hand-listed. Optional
 * and required members alike: an optional field a gate READS is still a field
 * that has to arrive from somewhere.
 */
function declaredFields(): string[] {
	const source = sourceWithoutComments(GATE_TYPES);
	const body = /export interface RampGateEvaluationInput \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
	return [...body.matchAll(/^\treadonly ([A-Za-z_$][\w$]*)\??:/gm)]
		.map((match) => match[1] ?? '')
		.filter((field) => field.length > 0);
}

/**
 * The keys of one object literal, at its TOP level only: a nested `now:` inside
 * some other argument says nothing about the gate input, and would credit a
 * supplier that does not exist.
 */
function topLevelKeys(literal: string): Set<string> {
	const keys = new Set<string>();
	let depth = 0;
	let index = 0;
	let quote: string | null = null;
	let atKeyPosition = false;
	while (index < literal.length) {
		const char = literal[index] ?? '';
		if (quote !== null) {
			if (char === '\\') index += 1;
			else if (char === quote) quote = null;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === '`') {
			quote = char;
			index += 1;
			continue;
		}
		if (char === '{' || char === '[' || char === '(') {
			depth += 1;
			atKeyPosition = depth === 1 && char === '{';
			index += 1;
			continue;
		}
		if (char === '}' || char === ']' || char === ')') {
			depth -= 1;
			atKeyPosition = false;
			index += 1;
			continue;
		}
		if (char === ',') {
			atKeyPosition = depth === 1;
			index += 1;
			continue;
		}
		if (atKeyPosition) {
			if (/\s/.test(char)) {
				index += 1;
				continue;
			}
			// `field: value` AND the SHORTHAND `field,` — the callers write both, and
			// a scanner that only understood the colon form would report the most
			// obviously-wired fields (`own`, `now`) as having no supplier at all.
			const match = /^([A-Za-z_$][\w$]*)\s*([:,}])/.exec(literal.slice(index));
			const key = match?.[1];
			if (key !== undefined) {
				keys.add(key);
				// Only the colon is consumed with the key: a `,` or `}` is a token the
				// loop above still has to see to track depth and the next key position.
				index += match?.[2] === ':' ? (match[0]?.length ?? 0) : key.length;
				atKeyPosition = false;
				continue;
			}
			atKeyPosition = false;
		}
		index += 1;
	}
	return keys;
}

/** Every `<something>.evaluate({ … })` object literal in one module. */
function evaluationLiterals(source: string): string[] {
	const literals: string[] = [];
	for (const match of source.matchAll(/\.evaluate\(\s*\{/g)) {
		const start = source.indexOf('{', match.index);
		let depth = 0;
		let quote: string | null = null;
		for (let index = start; index < source.length; index += 1) {
			const char = source[index];
			if (quote !== null) {
				if (char === '\\') index += 1;
				else if (char === quote) quote = null;
				continue;
			}
			if (char === "'" || char === '"' || char === '`') {
				quote = char;
				continue;
			}
			if (char === '{') depth += 1;
			if (char === '}') {
				depth -= 1;
				if (depth === 0) {
					literals.push(source.slice(start, index + 1));
					break;
				}
			}
		}
	}
	return literals;
}

/** Production modules that build a gate input, and the fields each one sets. */
const SUPPLIERS = new Map<string, Set<string>>();
for (const file of MODULES) {
	const fields = new Set<string>();
	for (const literal of evaluationLiterals(sourceWithoutComments(file))) {
		for (const key of topLevelKeys(literal)) fields.add(key);
	}
	if (fields.size > 0) SUPPLIERS.set(named(file), fields);
}

const FIELDS = declaredFields();

function suppliersFor(field: string): string[] {
	return [...SUPPLIERS].filter(([, fields]) => fields.has(field)).map(([file]) => file);
}

describe('the gate-input guard is looking at production', () => {
	it('walked the backend and skipped its tests', () => {
		expect(MODULES.length).toBeGreaterThan(100);
		expect(MODULES.filter((file) => named(file).includes('__tests__'))).toEqual([]);
		expect(MODULES.filter((file) => named(file).includes('_generated'))).toEqual([]);
	});

	it('read the field list off the interface, not off a hand-list', () => {
		// The empty-match failure mode: a renamed interface would make the field
		// list empty and this suite would assert nothing at all.
		expect(FIELDS).toContain('ownSeeds');
		expect(FIELDS).toContain('referenceSeeds');
		expect(FIELDS.length).toBeGreaterThanOrEqual(10);
	});

	it('found the callers that actually build one', () => {
		// Both of them, by name: the controller's read half and the screen. Losing
		// either is how a gate keeps deciding for the cron while the dashboard
		// renders a different verdict — or stops deciding at all.
		expect([...SUPPLIERS.keys()]).toContain('delivery/rampControllerInputs.ts');
		expect([...SUPPLIERS.keys()]).toContain('delivery/deliverabilityDashboard.ts');
	});

	it('credits nothing to a field no caller sets', () => {
		// The control: the extractor answers from the source, so a name no literal
		// contains must come back with no supplier at all.
		expect(suppliersFor('notAGateInputField')).toEqual([]);
	});

	it('reads only the TOP level of a literal, both spellings of a key', () => {
		// A nested key is not credited — `capacity` here supplies `capacity`, not
		// `projectedDemand` — and the shorthand `now` counts exactly like `own: a`.
		const keys = topLevelKeys('{ own: a, capacity: { projectedDemand: 1 }, now }');
		expect([...keys].sort()).toEqual(['capacity', 'now', 'own']);
	});
});

describe('every declared gate input has a production supplier', () => {
	for (const field of FIELDS) {
		const expectation = KNOWN_UNSUPPLIED.includes(field)
			? `${field} is a TRACKED gap — no production module sets it`
			: `${field} is set by a production caller`;
		it(expectation, () => {
			const suppliers = suppliersFor(field);
			if (KNOWN_UNSUPPLIED.includes(field)) {
				// Exact, not a floor: wiring a tracked gap without deleting its line
				// above fails here, so the list can only ever shrink.
				expect(suppliers).toEqual([]);
				return;
			}
			expect(suppliers).not.toEqual([]);
		});
	}

	it('every tracked gap is still a declared field', () => {
		// A gap for a field that no longer exists is dead documentation, and it
		// would silently excuse a future field that happened to reuse the name.
		expect(KNOWN_UNSUPPLIED.filter((field) => !FIELDS.includes(field))).toEqual([]);
	});
});
