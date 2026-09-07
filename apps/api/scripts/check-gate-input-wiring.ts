/**
 * EVERY GATE INPUT HAS A PRODUCTION SUPPLIER.
 *
 * `ownSeeds` and `referenceSeeds` were declared on `RampGateEvaluationInput`,
 * read by gate 5 and set by nobody, so the gate returned `insufficient_data`
 * for every cell of every deployment and no suite noticed — a gate suite hands
 * the gate an input; only the SOURCE knows whether a caller builds one. So:
 *
 *   1. THE FIELDS come off the interface declaration in `gateTypes.ts`;
 *   2. THE SUPPLIERS come off the object literals production modules pass to
 *      `.evaluate(...)`. A key whose value is a bare `null`/`undefined` supplies
 *      nothing — `ownSeeds: null` was the shipped spelling.
 *
 * ADR-0042: the controller and the dashboard build the SAME input off the same
 * rows, so every field is asserted against BOTH named readers. A gap may exist
 * only by being written down in the ledgers below, exactly.
 *
 * Run by `bun run lint` (apps/api): `bun scripts/check-gate-input-wiring.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const convexRoot = join(import.meta.dirname, '..', 'convex');
const GATE_TYPES = join(convexRoot, 'delivery', 'ramp', 'gateTypes.ts');

const failures: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}

/** Fields with no production supplier today, each written down. Exact. */
const KNOWN_UNSUPPLIED: readonly string[] = [];
/** The two production readers, named rather than counted. */
const REQUIRED_SUPPLIERS: readonly string[] = [
	'delivery/rampControllerInputs.ts',
	'delivery/deliverabilityDashboard.ts',
];
/** Fields only one reader supplies today, mapped to that reader. Exact. */
const KNOWN_ONE_SIDED: Readonly<Record<string, string>> = {};

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
const named = (file: string): string => relative(convexRoot, file);

function interfaceBody(): string {
	const source = sourceWithoutComments(GATE_TYPES);
	return /export interface RampGateEvaluationInput \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
}

// Only `readonly` members, which is how every one is spelled today; a member
// spelled any other way would leave this list silently, so `memberLines`
// counts the body a second way and the two counts must agree.
function fieldsIn(body: string): string[] {
	return [...body.matchAll(/^\treadonly ([A-Za-z_$][\w$]*)\??:/gm)]
		.map((match) => match[1] ?? '')
		.filter((field) => field.length > 0);
}

function memberLines(body: string): number {
	return [...body.matchAll(/^\t(?:readonly )?[A-Za-z_$][\w$]*\??:/gm)].length;
}

// The entries of one object literal — key to the SOURCE TEXT of its value — at
// its top level only. Shorthand `now,` maps to its own name (always a supply).
function topLevelEntries(literal: string): Map<string, string> {
	const entries = new Map<string, string>();
	let depth = 0;
	let index = 0;
	let quote: string | null = null;
	let atKeyPosition = false;
	let pending: { key: string; start: number } | null = null;
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
			const match = /^([A-Za-z_$][\w$]*)\s*([:,}])/.exec(literal.slice(index));
			const key = match?.[1];
			if (key !== undefined) {
				if (match?.[2] === ':') {
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

// Only the BARE literal is an absence: `seedSweeps.own` may well be null at run
// time, and that is a read of real evidence that came back empty.
const isHardcodedAbsence = (value: string): boolean => value === 'null' || value === 'undefined';

function suppliedKeys(literal: string): Set<string> {
	const keys = new Set<string>();
	for (const [key, value] of topLevelEntries(literal)) {
		if (!isHardcodedAbsence(value)) keys.add(key);
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
const suppliersFor = (field: string): string[] =>
	[...SUPPLIERS].filter(([, fields]) => fields.has(field)).map(([file]) => file);

// ─── The checks ─────────────────────────────────────────────────────────────

check(MODULES.length > 100, `walked only ${MODULES.length} modules`);
check(
	FIELDS.length > 0,
	'read no fields off RampGateEvaluationInput — the interface moved or was renamed'
);
check(
	FIELDS.length === memberLines(BODY),
	`RampGateEvaluationInput has ${memberLines(BODY)} members but ${FIELDS.length} spelled \`readonly\` — a member without it leaves this walk silently`
);
for (const supplier of REQUIRED_SUPPLIERS) {
	check(
		SUPPLIERS.has(supplier),
		`${supplier} builds no gate input at all — it is a required reader`
	);
}
for (const field of Object.keys(KNOWN_ONE_SIDED)) {
	check(!KNOWN_UNSUPPLIED.includes(field), `${field} is listed as both unsupplied and one-sided`);
	check(
		FIELDS.includes(field),
		`${field} is a tracked one-sided input but no longer a declared field`
	);
	check(
		REQUIRED_SUPPLIERS.includes(KNOWN_ONE_SIDED[field] ?? ''),
		`${field} names a one-sided supplier that is not a required reader`
	);
}
for (const field of KNOWN_UNSUPPLIED) {
	check(FIELDS.includes(field), `${field} is a tracked gap but no longer a declared field`);
}
for (const field of FIELDS) {
	const suppliers = suppliersFor(field);
	if (KNOWN_UNSUPPLIED.includes(field)) {
		check(
			suppliers.length === 0,
			`${field} is a tracked gap but is now supplied by ${suppliers.join(', ')} — delete its KNOWN_UNSUPPLIED line`
		);
		continue;
	}
	const oneSided = KNOWN_ONE_SIDED[field];
	if (oneSided !== undefined) {
		check(
			suppliers.length === 1 && suppliers[0] === oneSided,
			`${field} is tracked as supplied only by ${oneSided} but is supplied by [${suppliers.join(', ')}] — update KNOWN_ONE_SIDED`
		);
		continue;
	}
	for (const supplier of REQUIRED_SUPPLIERS) {
		check(
			suppliers.includes(supplier),
			`${field} is declared on RampGateEvaluationInput but ${supplier} does not supply it (a bare null/undefined is no supply) — wire it, or write the gap down in KNOWN_UNSUPPLIED / KNOWN_ONE_SIDED`
		);
	}
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL: ${failure}`);
	process.exit(1);
}
console.log(`check-gate-input-wiring: OK (${FIELDS.length} fields, ${SUPPLIERS.size} suppliers)`);
