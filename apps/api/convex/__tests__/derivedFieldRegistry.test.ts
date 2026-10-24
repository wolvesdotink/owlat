import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import schema from '../schema';
import { DERIVED_FIELD_REGISTRY } from '../maintenance/derivedFields/registry';
import type { RegistryEntry } from '../maintenance/derivedFields/types';
import { backendSources, findLabels, labelViolations, type SourceFile } from './derivedFieldLabels';

/**
 * Source gate for the derived-field registry
 * (`maintenance/derivedFields/registry.ts`): a field may only be labelled
 * `AGGREGATED` when the registry can recompute it, and `COUNTER` only with a
 * registered reason why nothing can. A new cache without a recount, a label
 * that drifted off its field, or an entry naming a field the schema no longer
 * has, fails here.
 */

const CONVEX_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface ValidatorJson {
	kind: string;
	fields?: Record<string, ValidatorJson>;
	members?: ValidatorJson[];
}

function hasSchemaPath(validator: ValidatorJson | undefined, segments: readonly string[]): boolean {
	if (!validator) return false;
	if (segments.length === 0) return true;
	if (validator.kind === 'union') {
		return (validator.members ?? []).some((member) => hasSchemaPath(member, segments));
	}
	if (validator.kind !== 'object') return false;
	const [head, ...rest] = segments;
	return hasSchemaPath(validator.fields?.[head as string], rest);
}

const tables = (schema as unknown as { tables: Record<string, { validator: ValidatorJson }> })
	.tables;

describe('derived-field registry', () => {
	it('registers every AGGREGATED and COUNTER label in the backend, on its own fields', () => {
		expect(labelViolations(backendSources(CONVEX_ROOT), DERIVED_FIELD_REGISTRY)).toEqual([]);
	});

	it('names only fields the schema declares', () => {
		const missing: string[] = [];
		for (const entry of DERIVED_FIELD_REGISTRY) {
			const table = tables[entry.table];
			for (const field of entry.fields) {
				if (!hasSchemaPath(table?.validator, field.split('.'))) {
					missing.push(`${entry.id}: ${entry.table}.${field}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it('gives every entry a unique id, a source or a reason, and no field twice', () => {
		const ids = DERIVED_FIELD_REGISTRY.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const paths = DERIVED_FIELD_REGISTRY.flatMap((entry) =>
			entry.fields.map((field) => `${entry.table}.${field}`)
		);
		expect(new Set(paths).size).toBe(paths.length);
		for (const entry of DERIVED_FIELD_REGISTRY) {
			const text = entry.kind === 'derived' ? entry.source : entry.why;
			expect(text.trim().length, entry.id).toBeGreaterThan(0);
		}
	});

	it('finds the labels the schema carries today', () => {
		const labels = backendSources(CONVEX_ROOT).flatMap(findLabels);
		const ids = new Set(labels.map((label) => label.id));
		for (const entry of DERIVED_FIELD_REGISTRY) expect(ids.has(entry.id), entry.id).toBe(true);
	});
});

describe('derived-field label scan', () => {
	const registry: RegistryEntry[] = [
		{
			kind: 'derived',
			id: 'roomActivity',
			table: 'chatRooms',
			fields: ['messageCount'],
			source: 'chatMessages',
			policy: 'exact',
			current: () => ({}),
			recompute: async () => ({ status: 'skipped', reason: 'over_budget' }),
		},
		{
			kind: 'derived',
			id: 'sendStats',
			table: 'campaigns',
			fields: ['statsSent'],
			spread: 'sharedStatFields',
			source: 'shards',
			policy: 'exact',
			current: () => ({}),
			recompute: async () => ({ status: 'skipped', reason: 'over_budget' }),
		},
		{
			kind: 'counter',
			id: 'usage',
			table: 'mailSnippets',
			fields: ['useCount'],
			why: 'no events',
		},
	];

	const clean: SourceFile[] = [
		{
			path: 'schema/chat.ts',
			text: [
				'export const chatTables = {',
				'\tchatRooms: defineTable({',
				'\t\t// AGGREGATED [roomActivity] — the room messages.',
				'\t\tmessageCount: v.number(),',
				'\t}),',
				'\tmailSnippets: defineTable({',
				'\t\tuseCount: v.optional(v.number()), // COUNTER [usage] — bumped on use',
				'\t}),',
				'};',
			].join('\n'),
		},
		{
			path: 'schema/campaigns.ts',
			text: [
				'\tcampaigns: defineTable({',
				'\t\t/**',
				'\t\t * AGGREGATED [sendStats] — summed shards.',
				'\t\t */',
				'\t\t...sharedStatFields,',
				'\t}),',
			].join('\n'),
		},
		{
			path: 'chat/messageInsert.ts',
			text: '\t// AGGREGATED [roomActivity] — the only writer.\n\t// A COUNTER of nothing in prose.',
		},
	];

	const withFile = (path: string, text: string) => [...clean, { path, text }];

	it('accepts labels on their fields, spreads and trailing comments', () => {
		expect(labelViolations(clean, registry)).toEqual([]);
	});

	it('fails an AGGREGATED label without an id', () => {
		const files = withFile(
			'schema/topics.ts',
			'\ttopics: defineTable({\n\t\t// AGGREGATED — member count.\n\t\tmemberCount: v.number(),\n\t}),'
		);
		expect(labelViolations(files, registry)).toEqual([
			'schema/topics.ts:2: AGGREGATED label without a registry id',
		]);
	});

	it('fails an unregistered id, nested and in a validator spread', () => {
		const files = withFile(
			'lib/validators/thread.ts',
			[
				'export const threadFields = {',
				'\toutbound: v.object({',
				'\t\t// AGGREGATED [threadState] — derived from recipients.',
				'\t\tstate: v.string(),',
				'\t}),',
				'};',
			].join('\n')
		);
		expect(labelViolations(files, registry)).toEqual([
			'lib/validators/thread.ts:3: AGGREGATED [threadState] is not in the registry',
		]);
	});

	it('fails a label on a field its entry does not name', () => {
		const files = withFile(
			'schema/chat2.ts',
			'\tchatRooms: defineTable({\n\t\t// AGGREGATED [roomActivity] — wrong field.\n\t\tlastReadAt: v.number(),\n\t}),'
		);
		expect(labelViolations(files, registry)).toEqual([
			'schema/chat2.ts:2: [roomActivity] labels `lastReadAt`, not one of its fields',
		]);
	});

	it('fails a label in another table', () => {
		const files = withFile(
			'schema/other.ts',
			'\totherRooms: defineTable({\n\t\t// AGGREGATED [roomActivity] — copy.\n\t\tmessageCount: v.number(),\n\t}),'
		);
		expect(labelViolations(files, registry)).toEqual([
			'schema/other.ts:2: [roomActivity] sits in table otherRooms, not chatRooms',
		]);
	});

	it('fails a counter labelled AGGREGATED, and the reverse', () => {
		const files = withFile(
			'mail/savedReplies.ts',
			'// AGGREGATED [usage] — bumped.\n// COUNTER [roomActivity] — counted.'
		);
		expect(labelViolations(files, registry)).toEqual([
			'mail/savedReplies.ts:1: [usage] is registered as COUNTER',
			'mail/savedReplies.ts:2: [roomActivity] is registered as AGGREGATED',
		]);
	});

	it('fails an entry no label points at', () => {
		const [first, ...rest] = clean;
		const files = [{ ...first!, text: first!.text.replace('COUNTER [usage]', 'counter') }, ...rest];
		expect(labelViolations(files, registry)).toEqual(['registry entry usage labels no field']);
	});
});
