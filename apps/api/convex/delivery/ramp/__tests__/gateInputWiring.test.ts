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
 * NAMING A FIELD IS NOT SUPPLYING IT. The defect that shipped was spelled
 * `ownSeeds: null` — the key was right there in the literal — so a scan that
 * credited key PRESENCE would have called the defect wired and stayed green
 * through the whole of it. A key whose value is a bare `null`/`undefined`
 * literal is therefore read as no supplier at all: that spelling says "this
 * caller has decided the field is absent", which is the same fact as omitting
 * it and must fail the same way.
 *
 * AND ONE READER IS NOT BOTH. ADR-0042 requires the controller and the screen to
 * build the SAME input off the same rows, so each field is asserted against BOTH
 * named callers rather than against a non-empty set — a field only one of them
 * sets is the controller/screen divergence this wave exists to repair, and it
 * would otherwise hide behind the other one's supply.
 *
 * A gap is allowed to EXIST — some evidence genuinely has no reader yet, and
 * some has only one — but only by being written down below, which makes it a
 * tracked absence instead of a silent one.
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
 * EMPTY, and the empty state is the point. `smtpBlocks` (issue #501) was the
 * last entry: the SMTP response classifier runs in the MTA and nothing carried
 * its per-category counts into Convex, so gate 2's block clause had a reader and
 * no producer and `evaluateSmtpBlockMessages` returned null on every tick of
 * every deployment. Closing it took the shape the line here predicted — the
 * category now travels as a TYPED field on an `smtp.classified` webhook (never
 * re-parsed out of a prose `message`, which would be a second classifier free to
 * disagree with the MTA's), and `analytics/smtpResponseCategories.ts` receives it
 * into a per-(org, cell, arm, day) sharded counter that both readers summarize.
 *
 * The MTA's daily Redis stream `mta:delivery-log:<day>` is still where to VERIFY
 * those categories in a live deployment; it is not, and never was, where to read
 * them from — a log rather than a counter, with no stream and no arm, so no
 * cell.
 *
 * A NEW GAP HAS TO BE WRITTEN DOWN HERE TO LAND, which is what makes an unsupplied
 * field a tracked absence instead of a silent one.
 */
const KNOWN_UNSUPPLIED: readonly string[] = [];

/**
 * THE TWO PRODUCTION READERS, named rather than counted. The controller's read
 * half decides for the cron; the dashboard renders what a human is told. ADR-0042
 * / plan D5 is that they build one input off one set of rows, so both have to
 * supply every field — a gate the screen answers from thinner evidence than the
 * controller is a screen that reports a friendlier verdict than the one being
 * acted on.
 */
const REQUIRED_SUPPLIERS: readonly string[] = [
	'delivery/rampControllerInputs.ts',
	'delivery/deliverabilityDashboard.ts',
];

/**
 * THE FIELDS ONLY ONE READER SUPPLIES TODAY, each mapped to the reader that
 * does. Asserted EXACTLY for the same reason `KNOWN_UNSUPPLIED` is: supplying
 * one of these from the second reader without deleting its line here fails this
 * suite, so the list can only shrink.
 *
 * EMPTY, and the empty state is the point: `ownTrailingBaseline` and
 * `hasComplaintFeedback` (issue #503) were the trailing-baseline evaluator's
 * substitution inputs, supplied by the cron and not by the screen. The dashboard
 * now makes the same integration-presence read and folds it through the same
 * `resolveRampDegradation`, so both arrive from both readers and both lines are
 * gone. A new one-sided field has to be written down here to land.
 */
const KNOWN_ONE_SIDED: Readonly<Record<string, string>> = {};

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

/** The interface's own body, comments already stripped. */
function interfaceBody(): string {
	const source = sourceWithoutComments(GATE_TYPES);
	return /export interface RampGateEvaluationInput \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
}

/**
 * The declared fields, read off the interface rather than hand-listed. Optional
 * and required members alike: an optional field a gate READS is still a field
 * that has to arrive from somewhere.
 *
 * Only members carrying `readonly`, which is how every one of them is spelled
 * today — and a member spelled any other way would leave this list SILENTLY,
 * taking its supplier assertion with it. That is the defect this file exists to
 * catch, reappearing inside the guard, so `memberLines` counts the body a second
 * way and the two counts are asserted equal below.
 */
function fieldsIn(body: string): string[] {
	return [...body.matchAll(/^\treadonly ([A-Za-z_$][\w$]*)\??:/gm)]
		.map((match) => match[1] ?? '')
		.filter((field) => field.length > 0);
}

/** EVERY member line of the body, `readonly` or not — the second count. */
function memberLines(body: string): number {
	return [...body.matchAll(/^\t(?:readonly )?[A-Za-z_$][\w$]*\??:/gm)].length;
}

/**
 * The entries of one object literal — key to the SOURCE TEXT of its value — at
 * its TOP level only: a nested `now:` inside some other argument says nothing
 * about the gate input, and would credit a supplier that does not exist.
 *
 * The value text is carried rather than discarded because the shipped defect was
 * a key with a value: `ownSeeds: null` names the field and supplies nothing, and
 * only the value tells the two apart. A shorthand `now` maps to its own name —
 * it IS a reference to a binding, so it is always a supply.
 */
function topLevelEntries(literal: string): Map<string, string> {
	const entries = new Map<string, string>();
	let depth = 0;
	let index = 0;
	let quote: string | null = null;
	let atKeyPosition = false;
	let pending: { key: string; start: number } | null = null;
	/** Close the value that started after the last consumed `:`, at `end`. */
	const closeValue = (end: number): void => {
		if (pending === null) return;
		entries.set(pending.key, literal.slice(pending.start, end).trim());
		pending = null;
	};
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
			// The literal's own closing brace ends the last value; a nested one is
			// part of a value still being read.
			if (depth === 1) closeValue(index);
			depth -= 1;
			atKeyPosition = false;
			index += 1;
			continue;
		}
		if (char === ',') {
			if (depth === 1) {
				closeValue(index);
				atKeyPosition = true;
			}
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
				if (match?.[2] === ':') {
					// Only the colon is consumed with the key: the value runs from here to
					// the next top-level `,` or `}`, both of which the loop still has to
					// see to track depth.
					index += match[0]?.length ?? 0;
					pending = { key, start: index };
				} else {
					entries.set(key, key);
					index += key.length;
				}
				atKeyPosition = false;
				continue;
			}
			atKeyPosition = false;
		}
		index += 1;
	}
	closeValue(literal.length);
	return entries;
}

/**
 * A value that SUPPLIES NOTHING. A caller writing the absence in by hand has
 * decided the field is absent for every cell of every deployment — the same fact
 * as omitting the key, reached by a spelling that names it — so it is credited
 * the same way: not at all.
 *
 * Only the BARE literal. `seedSweeps.own` may well be `null` at run time; that is
 * a read of real evidence that came back empty, which is the thing the gate is
 * supposed to see.
 */
function isHardcodedAbsence(value: string): boolean {
	return value === 'null' || value === 'undefined';
}

/** The keys of one literal that a production caller actually supplies a value for. */
function suppliedKeys(literal: string): Set<string> {
	const keys = new Set<string>();
	for (const [key, value] of topLevelEntries(literal)) {
		if (isHardcodedAbsence(value)) continue;
		keys.add(key);
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
		for (const key of suppliedKeys(literal)) fields.add(key);
	}
	if (fields.size > 0) SUPPLIERS.set(named(file), fields);
}

const BODY = interfaceBody();
const FIELDS = fieldsIn(BODY);

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
		// EVERY member is a field this suite asserts on. A count floor cannot see
		// ONE member going missing, which is the size the defect actually comes in,
		// so the body is counted a second way and the two must agree.
		expect(FIELDS.length).toBe(memberLines(BODY));
	});

	it('would notice a member that dropped `readonly`', () => {
		// The failure mode the equality above is there for, driven directly: the
		// field list misses `b`, the member count does not, and the suite goes red
		// instead of quietly asserting nothing about it.
		const body = '\treadonly a: number;\n\tb?: string;\n\treadonly c: X | null;';
		expect(fieldsIn(body)).toEqual(['a', 'c']);
		expect(memberLines(body)).toBe(3);
		// And a nested member is not a member of THIS interface — it belongs to the
		// type in value position, and counting it would fail the equality forever.
		expect(memberLines('\treadonly cfg: {\n\t\treadonly inner: number;\n\t};')).toBe(1);
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
		const keys = suppliedKeys('{ own: a, capacity: { projectedDemand: 1 }, now }');
		expect([...keys].sort()).toEqual(['capacity', 'now', 'own']);
	});

	it('reads each key back with the SOURCE TEXT of its value', () => {
		// The value is what tells a supply from a hand-written absence, so it has to
		// survive a nested literal, a trailing comma and a call in value position.
		const entries = topLevelEntries('{ own: a, seeds: sweeps.own, cfg: { k: 1 }, now: f(x), }');
		expect([...entries]).toEqual([
			['own', 'a'],
			['seeds', 'sweeps.own'],
			['cfg', '{ k: 1 }'],
			['now', 'f(x)'],
		]);
	});

	it('refuses a hardcoded absence as a supplier — the shipped defect, spelled out', () => {
		// THE EXACT LITERAL THAT SHIPPED. `deliverabilityDashboard.ts` named both
		// seed fields and passed `null` for each, so a key-presence scan would have
		// called gate 5 wired for the entire time it could not reach a verdict.
		const keys = suppliedKeys('{ own, ownSeeds: null, referenceSeeds: undefined }');
		expect([...keys].sort()).toEqual(['own']);
		// A READ that happens to be null-valued at run time is still a supply: only
		// the bare literal is the caller deciding on the deployment's behalf.
		expect([...suppliedKeys('{ ownSeeds: sweeps.own ?? null }')]).toEqual(['ownSeeds']);
	});

	it('keeps the tracked lists disjoint and about fields that exist', () => {
		// A gap listed twice, or listed for a field that no longer exists, is dead
		// documentation that would silently excuse a future field of the same name.
		const oneSided = Object.keys(KNOWN_ONE_SIDED);
		expect(oneSided.filter((field) => KNOWN_UNSUPPLIED.includes(field))).toEqual([]);
		expect(oneSided.filter((field) => !FIELDS.includes(field))).toEqual([]);
		expect(Object.values(KNOWN_ONE_SIDED).filter((s) => !REQUIRED_SUPPLIERS.includes(s))).toEqual(
			[]
		);
	});
});

describe('every declared gate input has a production supplier', () => {
	for (const field of FIELDS) {
		const oneSided = KNOWN_ONE_SIDED[field];
		const expectation = KNOWN_UNSUPPLIED.includes(field)
			? `${field} is a TRACKED gap — no production module sets it`
			: oneSided !== undefined
				? `${field} is a TRACKED one-sided input — only ${oneSided} sets it`
				: `${field} is set by BOTH production callers`;
		it(expectation, () => {
			const suppliers = suppliersFor(field);
			if (KNOWN_UNSUPPLIED.includes(field)) {
				// Exact, not a floor: wiring a tracked gap without deleting its line
				// above fails here, so the list can only ever shrink.
				expect(suppliers).toEqual([]);
				return;
			}
			if (oneSided !== undefined) {
				// Exact for the same reason, in the other direction: the second reader
				// starting to supply this field fails here until the line is deleted.
				expect(suppliers).toEqual([oneSided]);
				return;
			}
			// BOTH, by name. A non-empty check would let the controller keep supplying
			// a field the screen dropped, which is the divergence, not the fix.
			for (const supplier of REQUIRED_SUPPLIERS) expect(suppliers).toContain(supplier);
		});
	}

	it('every tracked gap is still a declared field', () => {
		// A gap for a field that no longer exists is dead documentation, and it
		// would silently excuse a future field that happened to reuse the name.
		expect(KNOWN_UNSUPPLIED.filter((field) => !FIELDS.includes(field))).toEqual([]);
	});
});
