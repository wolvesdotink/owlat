import { v, type JSONValue, type Validator, type ValidatorJSON } from 'convex/values';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { rowsForTable } from './rows';
import { readSnapshot } from './snapshot';
import { schemaMismatch } from './validate';

/**
 * RELEASE DATA COMPATIBILITY. An upgraded deployment keeps every row the
 * previous release wrote, and the deploy refuses a schema those rows do not
 * validate against. So every row shape the previous release's schema allowed
 * must still validate against the current one. This builds those rows from the
 * snapshot in `previousRelease.json` and checks each one.
 *
 * A failure here means the PR makes an existing optional field required,
 * changes a field's type, narrows a union, drops a field or drops a table
 * without first migrating the data. The fix is the expand/migrate/contract
 * sequence in `convex/CONVENTIONS.md` ("Release data compatibility"), not an
 * edit to the snapshot. The snapshot only moves forward at a release
 * (`bun run --cwd apps/api schema-compat:refresh`).
 */

/**
 * Tables the current release deliberately retired. A table leaves the schema
 * only in the contract step, after a shipped migration emptied it; name it
 * here in that same PR.
 */
const RETIRED_TABLES: ReadonlySet<string> = new Set();

/**
 * Fields the current release deliberately removed, per table, as paths into a
 * row: `.` between fields, `[]` for every element of an array. Like a retired
 * table, a field leaves the schema only in the contract step, after a shipped
 * migration emptied it on every deployment; name it here in that same PR, with
 * the migration. The check then reads the previous release's rows as that
 * migration left them, without the field, and still checks the rest of each
 * row. The deploy enforces the precondition: Convex rejects a schema that a
 * stored row does not match, so a deployment where the migration has not
 * completed keeps running its old release. An entry becomes inert once the
 * snapshot no longer has the field; drop it at that refresh.
 */
const RETIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
	// 0066_backfill_clarification_origin (0.6.10) moved every legacy sentence
	// to `origin`; #1224 dropped the field.
	answerAskSessions: ['questions[].attribution'],
	mailThreads: ['needsReply.clarification.questions[].attribution'],
};

/** `row` without the field at `path` (see {@link RETIRED_FIELDS}). */
function withoutField(row: JSONValue, path: readonly string[]): JSONValue {
	const [segment, ...rest] = path;
	if (segment === undefined || row === null || typeof row !== 'object' || Array.isArray(row)) {
		return row;
	}
	const isArray = segment.endsWith('[]');
	const name = isArray ? segment.slice(0, -2) : segment;
	if (!(name in row)) return row;
	if (rest.length === 0) {
		const { [name]: _removed, ...kept } = row;
		return kept;
	}
	const value = row[name] as JSONValue;
	const next =
		isArray && Array.isArray(value)
			? value.map((item) => withoutField(item, rest))
			: withoutField(value, rest);
	return { ...row, [name]: next };
}

function withoutRetiredFields(row: JSONValue, paths: readonly string[] = []): JSONValue {
	return paths.reduce((current, path) => withoutField(current, path.split('.')), row);
}

const currentTables = schema.tables as unknown as Record<
	string,
	{ validator: { json: ValidatorJSON } }
>;

function incompatibilities(
	previous: Record<string, ValidatorJSON>,
	current: Record<string, ValidatorJSON>,
	retired: ReadonlySet<string> = new Set(),
	retiredFields: Readonly<Record<string, readonly string[]>> = {}
): string[] {
	const problems: string[] = [];
	for (const [table, validator] of Object.entries(previous)) {
		const next = current[table];
		if (!next) {
			if (!retired.has(table)) problems.push(`${table}: table is no longer in the schema`);
			continue;
		}
		for (const [index, row] of rowsForTable(validator).entries()) {
			const problem = schemaMismatch(next, withoutRetiredFields(row, retiredFields[table]));
			if (problem) problems.push(`${table} row ${index}: ${problem}`);
		}
	}
	return problems;
}

function currentValidators(): Record<string, ValidatorJSON> {
	return Object.fromEntries(
		Object.entries(currentTables).map(([name, table]) => [name, table.validator.json])
	);
}

describe('previous-release rows still validate', () => {
	const snapshot = readSnapshot();

	it('the snapshot is a real release', () => {
		expect(snapshot.release).toMatch(/^v\d+\.\d+\.\d+$/);
		expect(Object.keys(snapshot.tables).length).toBeGreaterThan(100);
	});

	it(`every row shape ${snapshot.release} could store validates against the current schema`, () => {
		expect(
			incompatibilities(snapshot.tables, currentValidators(), RETIRED_TABLES, RETIRED_FIELDS)
		).toEqual([]);
	});

	it('names no retired table that is still in the schema', () => {
		expect([...RETIRED_TABLES].filter((table) => table in currentTables)).toEqual([]);
	});

	it('names no retired field that is still in the schema', () => {
		// A row with every optional field present carries each field the schema
		// has; removing a retired one from it must change nothing.
		const current = currentValidators();
		const stillThere = Object.entries(RETIRED_FIELDS).flatMap(([table, paths]) => {
			const validator = current[table];
			if (!validator) return [`${table}: table is no longer in the schema`];
			return paths.filter((path) =>
				rowsForTable(validator).some(
					(row) => JSON.stringify(withoutRetiredFields(row, [path])) !== JSON.stringify(row)
				)
			);
		});
		expect(stillThere).toEqual([]);
	});
});

describe('the compatibility check itself', () => {
	// `json` is how `defineSchema` exports a validator; convex keeps it out of
	// the public types, so the tables above and these fixtures read it the same way.
	const table = (fields: Parameters<typeof v.object>[0]) =>
		(v.object(fields) as unknown as { json: ValidatorJSON }).json;
	const previous = {
		sends: table({
			status: v.union(v.literal('queued'), v.literal('sent')),
			sentAt: v.optional(v.number()),
			tags: v.array(v.string()),
			meta: v.optional(v.record(v.string(), v.boolean())),
			contactId: v.id('contacts'),
		}),
	};
	const check = (current: ValidatorJSON) => incompatibilities(previous, { sends: current });

	it('accepts its own rows, and the current schema accepts its own rows', () => {
		expect(incompatibilities(previous, previous)).toEqual([]);
		expect(incompatibilities(currentValidators(), currentValidators())).toEqual([]);
	});

	it('accepts additive changes: a new optional field, a widened union', () => {
		expect(
			check(
				table({
					status: v.union(v.literal('queued'), v.literal('sent'), v.literal('bounced')),
					sentAt: v.optional(v.number()),
					tags: v.array(v.string()),
					meta: v.optional(v.record(v.string(), v.boolean())),
					contactId: v.id('contacts'),
					bouncedAt: v.optional(v.number()),
				})
			)
		).toEqual([]);
	});

	it('rejects an optional field that became required', () => {
		expect(
			check(
				table({
					status: v.union(v.literal('queued'), v.literal('sent')),
					sentAt: v.number(),
					tags: v.array(v.string()),
					meta: v.optional(v.record(v.string(), v.boolean())),
					contactId: v.id('contacts'),
				})
			)
		).toContain('sends row 0: sentAt: required field missing');
	});

	it('rejects a new required field', () => {
		expect(
			check(
				table({
					status: v.union(v.literal('queued'), v.literal('sent')),
					sentAt: v.optional(v.number()),
					tags: v.array(v.string()),
					meta: v.optional(v.record(v.string(), v.boolean())),
					contactId: v.id('contacts'),
					region: v.string(),
				})
			)
		).toContain('sends row 0: region: required field missing');
	});

	it('rejects a changed field type, including inside arrays and records', () => {
		const base = {
			status: v.union(v.literal('queued'), v.literal('sent')),
			sentAt: v.optional(v.number()),
			tags: v.array(v.string()),
			meta: v.optional(v.record(v.string(), v.boolean())),
			contactId: v.id('contacts'),
		};
		expect(check(table({ ...base, sentAt: v.optional(v.string()) })).join('\n')).toContain(
			'sentAt: expected string'
		);
		expect(check(table({ ...base, tags: v.array(v.number()) })).join('\n')).toContain(
			'tags[0]: expected number'
		);
		expect(
			check(table({ ...base, meta: v.optional(v.record(v.string(), v.string())) })).join('\n')
		).toContain('meta.fixture: expected string');
		expect(check(table({ ...base, contactId: v.id('users') })).join('\n')).toContain(
			'contactId: expected id of users'
		);
	});

	it('rejects a narrowed union', () => {
		expect(
			check(
				table({
					status: v.literal('queued'),
					sentAt: v.optional(v.number()),
					tags: v.array(v.string()),
					meta: v.optional(v.record(v.string(), v.boolean())),
					contactId: v.id('contacts'),
				})
			).join('\n')
		).toContain('status: expected literal "queued", got "sent"');
	});

	it('rejects a dropped field and a dropped table', () => {
		expect(
			check(
				table({
					status: v.union(v.literal('queued'), v.literal('sent')),
					tags: v.array(v.string()),
					meta: v.optional(v.record(v.string(), v.boolean())),
					contactId: v.id('contacts'),
				})
			)
		).toContain('sends row 1: sentAt: field is no longer in the schema');
		expect(incompatibilities(previous, {})).toEqual(['sends: table is no longer in the schema']);
		expect(incompatibilities(previous, {}, new Set(['sends']))).toEqual([]);
	});

	it('accepts a retired field and still checks the rest of the row', () => {
		const nested = (fields: Parameters<typeof v.object>[0]) =>
			table({ items: v.array(v.object(fields)), at: v.number() });
		const before = { t: nested({ id: v.string(), legacy: v.string() }) };
		const retired = { t: ['items[].legacy'] };
		expect(incompatibilities(before, { t: nested({ id: v.string() }) })).toContain(
			't row 0: items[0].legacy: field is no longer in the schema'
		);
		expect(
			incompatibilities(before, { t: nested({ id: v.string() }) }, new Set(), retired)
		).toEqual([]);
		expect(
			incompatibilities(
				before,
				{ t: table({ items: v.array(v.object({ id: v.number() })), at: v.number() }) },
				new Set(),
				retired
			).join('\n')
		).toContain('items[0].id: expected number');
	});

	it('rejects a nested optional field made required under an optional parent', () => {
		// An old row may hold `settings: {}`: the parent present, its optionals omitted.
		expect(
			incompatibilities(
				{ t: table({ settings: v.optional(v.object({ foo: v.optional(v.string()) })) }) },
				{ t: table({ settings: v.optional(v.object({ foo: v.string() })) }) }
			).join('\n')
		).toContain('settings.foo: required field missing');
	});

	it('rejects an optional field made required inside a non-first union member', () => {
		const state = (at: Validator<number | undefined, 'required' | 'optional'>) =>
			table({
				state: v.union(v.object({ kind: v.literal('a') }), v.object({ kind: v.literal('b'), at })),
			});
		expect(
			incompatibilities({ t: state(v.optional(v.number())) }, { t: state(v.number()) }).join('\n')
		).toContain('state: expected one of object | object, got {"kind":"b"}');
	});

	it('rejects a narrowed union nested in a later member of a wider union', () => {
		const y = v.union(v.literal(1), v.literal(2), v.literal(3), v.literal(4));
		expect(
			incompatibilities(
				{
					t: table({
						x: v.union(
							v.object({ k: v.literal('a') }),
							v.object({ k: v.literal('b'), m: v.union(v.literal('p'), v.literal('q')) })
						),
						y,
					}),
				},
				{
					t: table({
						x: v.union(
							v.object({ k: v.literal('a') }),
							v.object({ k: v.literal('b'), m: v.literal('q') })
						),
						y,
					}),
				}
			).join('\n')
		).toContain('x: expected one of object | object, got {"k":"b","m":"p"}');
	});

	it('keeps the row count per table small enough to check every release', () => {
		const counts = Object.values(readSnapshot().tables).map(
			(validator) => rowsForTable(validator).length
		);
		expect(Math.max(...counts)).toBeLessThan(2_000);
	});
});
