import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createTestContact } from './factories';
import { newHarness } from './testModules';
import {
	CONTACT_RELATIONS,
	DESCENDANT_RELATIONS,
	type ErasureRelation,
} from '../contacts/erasure/relations';
import {
	CONTACT_MERGE_EXCLUSIONS,
	permanentlyDeleteContactWithRelations,
} from '../lib/contactMutations';

/**
 * The relation registry (`contacts/erasure/relations.ts`) declares what erasure
 * does to every reference; the schema coverage test keeps the declarations
 * complete, but nothing tied a declaration to the phase that carries it out. A
 * `delete` or `unlink` relation with no phase behind it would pass both.
 *
 * This seeds one row per declared `delete`/`unlink` relation, built from the
 * table's own schema validator (so a new table needs no hand-written fixture),
 * pointing at the erased contact — or, for a descendant, at a seeded parent
 * row the erasure deletes — then runs the erasure both ways it runs in
 * production and checks each row is gone or no longer points there.
 */

type Harness = TestConvex<typeof schema>;
type Row = Record<string, unknown>;

interface Validator {
	kind: string;
	isOptional?: 'optional' | 'required';
	tableName?: string;
	value?: unknown;
	fields?: Record<string, Validator>;
	members?: Validator[];
}

const TABLES = (schema as unknown as { tables: Record<string, { validator: Validator }> }).tables;

const isClearing = (relation: ErasureRelation): boolean => relation.action !== 'retain';
const baseField = (field: string): string => field.replace(/\[\]$/, '');

/** Builds schema-valid rows, creating a stub row for every required reference. */
class RowSeeder {
	private readonly stubs = new Map<string, Id<TableNames> | Id<'_storage'>>();

	constructor(private readonly ctx: MutationCtx) {}

	async row(table: TableNames, overrides: Row): Promise<Row> {
		const validator = TABLES[table]?.validator;
		if (!validator) throw new Error(`unknown table ${table}`);
		const row = (await this.value(validator)) as Row;
		return { ...row, ...overrides };
	}

	async insert(table: TableNames, overrides: Row): Promise<Id<TableNames>> {
		return this.ctx.db.insert(table, (await this.row(table, overrides)) as never);
	}

	private async stub(table: string): Promise<Id<TableNames> | Id<'_storage'>> {
		const existing = this.stubs.get(table);
		if (existing) return existing;
		const id =
			table === '_storage'
				? // convex-test's context can store blobs; a production mutation cannot.
					await (
						this.ctx.storage as unknown as { store(blob: Blob): Promise<Id<'_storage'>> }
					).store(new Blob(['fixture']))
				: await this.insert(table as TableNames, {});
		this.stubs.set(table, id);
		return id;
	}

	private async value(validator: Validator): Promise<unknown> {
		switch (validator.kind) {
			case 'id':
				return this.stub(validator.tableName!);
			case 'string':
			case 'any':
				return 'fixture';
			case 'float64':
				return 1;
			case 'int64':
				return 1n;
			case 'boolean':
				return false;
			case 'null':
				return null;
			case 'bytes':
				return new ArrayBuffer(1);
			case 'literal':
				return validator.value;
			case 'array':
				return [];
			case 'record':
				return {};
			case 'union':
				return this.value(validator.members![0]!);
			case 'object': {
				const row: Row = {};
				for (const [name, field] of Object.entries(validator.fields ?? {})) {
					if (field.isOptional === 'optional') continue;
					row[name] = await this.value(field);
				}
				return row;
			}
		}
		throw new Error(`no fixture value for validator kind ${validator.kind}`);
	}
}

/** Per-table extras that put a seeded row on the path its phase walks. */
const ROW_SHAPES: Partial<Record<TableNames, Row>> = {
	// Only an inbound capture scoped to the contact alone is deleted; any other
	// file just loses the link. Seed the deleting case so its descendants run.
	semanticFiles: { captureSource: 'team_inbox' },
};

/**
 * Descendants whose reference is nested (`a.b`, `a[].b`): the row is built
 * around the parent here, since the generic seeder can only set a top-level
 * field. Both put the claim in a Team Inbox thread the contact does not own,
 * which the message erasure has to clean up on its own.
 */
const NESTED_SEEDS: Record<
	string,
	(ctx: MutationCtx, seeder: RowSeeder, parentId: Id<TableNames>) => Promise<Row>
> = {
	'messageInterpretations.source.id': async (ctx, seeder, parentId) => ({
		...(await foreignThread(ctx, seeder, parentId)),
		source: { kind: 'inbound', id: parentId },
		sourceKey: `inbound:${parentId}`,
	}),
	'interpretSources.source.id': async (ctx, seeder, parentId) => ({
		...(await foreignThread(ctx, seeder, parentId)),
		source: { kind: 'inbound', id: parentId },
		sourceKey: `inbound:${parentId}`,
	}),
	'threadItems.pendingUpdate.evidence[].source.id': async (ctx, seeder, parentId) => {
		const evidence = [
			{
				source: { kind: 'inbound', id: parentId },
				segmentId: 's0',
				start: 0,
				end: 1,
				contentRevision: 'rev',
			},
		];
		return {
			...(await foreignThread(ctx, seeder, parentId)),
			evidence,
			pendingUpdate: { evidence },
		};
	},
	'threadItems.evidence[].source.id': async (ctx, seeder, parentId) => ({
		...(await foreignThread(ctx, seeder, parentId)),
		evidence: [
			{
				source: { kind: 'inbound', id: parentId },
				segmentId: 's0',
				start: 0,
				end: 1,
				contentRevision: 'rev',
			},
		],
	}),
};

/** Put the seeded inbound message in a thread of its own; the row's thread fields. */
async function foreignThread(
	ctx: MutationCtx,
	seeder: RowSeeder,
	messageId: Id<TableNames>
): Promise<Row> {
	const message = (await ctx.db.get(messageId as Id<'inboundMessages'>))!;
	const threadId =
		message.threadId ??
		((await seeder.insert('conversationThreads', {})) as Id<'conversationThreads'>);
	await ctx.db.patch(message._id, { threadId });
	return { threadKind: 'team', conversationThreadId: threadId };
}

/** Every value at a field path (`a.b`, `a[].b`) of a row. */
function valuesAt(value: unknown, path: string[]): unknown[] {
	if (path.length === 0) return [value];
	const [head, ...rest] = path;
	const isArray = head!.endsWith('[]');
	const next = (value as Row | undefined)?.[isArray ? head!.slice(0, -2) : head!];
	if (isArray) return Array.isArray(next) ? next.flatMap((el) => valuesAt(el, rest)) : [];
	return next === undefined ? [] : valuesAt(next, rest);
}

interface SeededRow {
	/** `table.field`, plus `→ parent` for a descendant. */
	label: string;
	id: Id<TableNames>;
	relation: ErasureRelation;
}

interface Seeded {
	contactId: Id<'contacts'>;
	/** The seeded rows that must be gone or unlinked after the erasure. */
	rows: SeededRow[];
}

/**
 * Seed one row per contact relation in `relations`, pointing at `contactId`.
 * Parents first: the junction tables must point at the seeded entry/file (the
 * knowledge and file phases, and the merge's junction repoint, are
 * junction-driven). Returns the seeded rows and the ids by table.
 */
async function seedContactRelations(
	seeder: RowSeeder,
	contactId: Id<'contacts'>,
	relations: readonly ErasureRelation[]
): Promise<{ rows: SeededRow[]; parents: Map<TableNames, Id<TableNames>> }> {
	const rows: SeededRow[] = [];
	const parents = new Map<TableNames, Id<TableNames>>();
	const ordered = [...relations]
		.sort((a, b) => Number(a.field.endsWith('[]')) - Number(b.field.endsWith('[]')))
		.reverse();
	for (const relation of ordered) {
		const field = baseField(relation.field);
		const junctionParent =
			relation.table === 'knowledgeEntryContacts'
				? { entryId: parents.get('knowledgeEntries') }
				: relation.table === 'semanticFileContacts'
					? { fileId: parents.get('semanticFiles') }
					: {};
		const id = await seeder.insert(relation.table, {
			...ROW_SHAPES[relation.table],
			...junctionParent,
			// A contact id in a plain string only counts beside its discriminator.
			...(relation.when ? { [relation.when.field]: relation.when.equals } : {}),
			[field]: relation.field.endsWith('[]') ? [contactId] : contactId,
		});
		parents.set(relation.table, id);
		rows.push({ label: `${relation.table}.${relation.field}`, id, relation });
	}
	return { rows, parents };
}

async function seedEveryClearingRelation(t: Harness, contactFields: Row): Promise<Seeded> {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact(contactFields));
		const seeder = new RowSeeder(ctx);
		const { rows, parents } = await seedContactRelations(
			seeder,
			contactId,
			CONTACT_RELATIONS.filter(isClearing)
		);

		for (const relation of DESCENDANT_RELATIONS.filter(isClearing)) {
			const parentId = parents.get(relation.parent);
			if (!parentId) throw new Error(`no seeded ${relation.parent} for ${relation.table}`);
			const nested = NESTED_SEEDS[`${relation.table}.${relation.field}`];
			if (!nested && /[.[]/.test(relation.field)) {
				throw new Error(`no seed for nested ${relation.table}.${relation.field}`);
			}
			const id = await seeder.insert(
				relation.table,
				nested ? await nested(ctx, seeder, parentId) : { [relation.field]: parentId }
			);
			// A descendant can parent the next level (a thread's note, then the
			// note's mention rows): later relations hang off the first one seeded.
			if (!parents.has(relation.table)) parents.set(relation.table, id);
			rows.push({
				label: `${relation.table}.${relation.field} → ${relation.parent}`,
				id,
				relation,
			});
		}
		return { contactId, rows };
	});
}

/** Every seeded row that is still there and still points at what was erased. */
async function survivors(t: Harness, seeded: Seeded): Promise<string[]> {
	return t.run(async (ctx) => {
		const left: string[] = [];
		for (const { label, id, relation } of seeded.rows) {
			const row = (await ctx.db.get(id)) as Row | null;
			if (row === null) continue;
			const value = row[baseField(relation.field)];
			const target = 'parent' in relation ? undefined : seeded.contactId;
			const isNested = /[.[]/.test(baseField(relation.field));
			const stillPoints = isNested
				? valuesAt(row, relation.field.split('.')).length > 0
				: relation.field.endsWith('[]')
					? Array.isArray(value) && value.includes(target)
					: target === undefined
						? value !== undefined
						: value === target;
			if (relation.action === 'delete' || stillPoints) left.push(label);
		}
		return left.sort();
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('every delete/unlink relation has a phase behind it', () => {
	it('seeds a row for every declared relation', async () => {
		const t = newHarness();
		const seeded = await seedEveryClearingRelation(t, {});
		const declared =
			CONTACT_RELATIONS.filter(isClearing).length + DESCENDANT_RELATIONS.filter(isClearing).length;
		expect(seeded.rows).toHaveLength(declared);
	});

	it('inline erasure (organization wipe, sample data) clears them all', async () => {
		const t = newHarness();
		const seeded = await seedEveryClearingRelation(t, {});

		await t.run((ctx) => permanentlyDeleteContactWithRelations(ctx, seeded.contactId));

		expect(await survivors(t, seeded)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get(seeded.contactId))).toBeNull();
	});

	it('the persisted walker (retention, REST delete) clears them all', async () => {
		const t = newHarness();
		const seeded = await seedEveryClearingRelation(t, { deletedAt: Date.now() - 40 * 86_400_000 });
		// The seeded contactErasureJobs row is the contact's job; drive it.
		const job = seeded.rows.find((row) => row.label === 'contactErasureJobs.contactId');
		if (!job) throw new Error('no seeded erasure job');

		let outcome = 'more';
		for (let i = 0; i < 50 && outcome === 'more'; i++) {
			outcome = await t.mutation(internal.contacts.erasure.walker.tick, {
				jobId: job.id as Id<'contactErasureJobs'>,
			});
		}

		expect(outcome).toBe('done');
		expect(await survivors(t, seeded)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get(seeded.contactId))).toBeNull();
	});
});

/**
 * A merge moves the source's rows onto the survivor and hard-deletes the
 * source (#1337), so a later erasure of the survivor is the only one that can
 * reach them. Seed the source with a row for every contact relation the merge
 * moves, run a real merge, and check that nothing is left on the deleted
 * source and that erasing the survivor clears the rows both ways it runs.
 */
interface MergePair {
	targetId: Id<'contacts'>;
	sourceId: Id<'contacts'>;
	rows: SeededRow[];
}

const movedByMerge = (relation: ErasureRelation): boolean =>
	!(`${relation.table}.${relation.field}` in CONTACT_MERGE_EXCLUSIONS);

async function seedMergePair(t: Harness): Promise<MergePair> {
	return t.run(async (ctx) => {
		// The oldest contact survives an auto-merge.
		const targetId = await ctx.db.insert('contacts', createTestContact());
		const sourceId = await ctx.db.insert('contacts', createTestContact());
		const seeder = new RowSeeder(ctx);
		const { rows } = await seedContactRelations(
			seeder,
			sourceId,
			CONTACT_RELATIONS.filter(movedByMerge)
		);
		// A shared address on a strong channel makes the two a duplicate pair.
		for (const contactId of [targetId, sourceId]) {
			await seeder.insert('contactIdentities', {
				contactId,
				channel: 'email',
				identifier: 'shared@example.com',
			});
		}
		return { targetId, sourceId, rows };
	});
}

async function mergePair(t: Harness): Promise<void> {
	const { merged } = await t.mutation(internal.contacts.identities.autoMergeDuplicates, {});
	expect(merged).toBe(1);
}

/** Labels of the seeded rows that still exist and reference `contactId`. */
async function rowsPointingAt(
	t: Harness,
	rows: SeededRow[],
	contactId: Id<'contacts'>
): Promise<string[]> {
	return t.run(async (ctx) => {
		const pointing: string[] = [];
		for (const { label, id, relation } of rows) {
			const row = (await ctx.db.get(id)) as Row | null;
			const value = row?.[baseField(relation.field)];
			const points = Array.isArray(value) ? value.includes(contactId) : value === contactId;
			if (points) pointing.push(label);
		}
		return pointing.sort();
	});
}

describe('a merged contact’s rows reach the survivor’s erasure', () => {
	it('moves every relation off the deleted source onto the survivor', async () => {
		const t = newHarness();
		const pair = await seedMergePair(t);

		await mergePair(t);

		expect(await t.run((ctx) => ctx.db.get(pair.sourceId))).toBeNull();
		expect(await rowsPointingAt(t, pair.rows, pair.sourceId)).toEqual([]);
		expect(await rowsPointingAt(t, pair.rows, pair.targetId)).toEqual(
			pair.rows.map((row) => row.label).sort()
		);
	});

	it('inline erasure of the survivor clears them', async () => {
		const t = newHarness();
		const pair = await seedMergePair(t);
		await mergePair(t);

		await t.run((ctx) => permanentlyDeleteContactWithRelations(ctx, pair.targetId));

		const clearing = pair.rows.filter((row) => isClearing(row.relation));
		expect(await survivors(t, { contactId: pair.targetId, rows: clearing })).toEqual([]);
		expect(await rowsPointingAt(t, pair.rows, pair.sourceId)).toEqual([]);
	});

	it('the persisted walker erasing the survivor clears them', async () => {
		const t = newHarness();
		const pair = await seedMergePair(t);
		await mergePair(t);
		const jobId = await t.run(async (ctx) => {
			await ctx.db.patch(pair.targetId, { deletedAt: Date.now() - 40 * 86_400_000 });
			return (await new RowSeeder(ctx).insert('contactErasureJobs', {
				contactId: pair.targetId,
			})) as Id<'contactErasureJobs'>;
		});

		let outcome = 'more';
		for (let i = 0; i < 50 && outcome === 'more'; i++) {
			outcome = await t.mutation(internal.contacts.erasure.walker.tick, { jobId });
		}

		expect(outcome).toBe('done');
		const clearing = pair.rows.filter((row) => isClearing(row.relation));
		expect(await survivors(t, { contactId: pair.targetId, rows: clearing })).toEqual([]);
		expect(await rowsPointingAt(t, pair.rows, pair.sourceId)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get(pair.targetId))).toBeNull();
	});
});
