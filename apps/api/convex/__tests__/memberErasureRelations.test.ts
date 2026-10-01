import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { tables as betterAuthTables } from '../betterAuth/schema';
import {
	DESCENDANT_RELATIONS,
	IDENTITY_TABLES,
	MEMBER_REFERENCE_FIELD,
	MEMBER_RELATIONS,
	tablesErasureDeletesFrom,
} from '../auth/erasure/relations';

/**
 * Schema coverage gate for the member erasure relation registry
 * (`auth/erasure/relations.ts` + `descendantRelations.ts`). A new field that
 * names a user, a new table under a mailbox, a new reference to anything the
 * erasure deletes, or a new BetterAuth table fails here until it declares
 * what erasing an account does to it — the handwritten walker had silently
 * fallen behind the schema (assistant transcripts and archive uploads
 * survived a "completed" erasure).
 */

interface ValidatorJson {
	kind: string;
	tableName?: string;
	fields?: Record<string, ValidatorJson>;
	element?: ValidatorJson;
	members?: ValidatorJson[];
	value?: ValidatorJson;
}

type Match = (validator: ValidatorJson, leaf: string) => boolean;

function collect(
	validator: ValidatorJson | undefined,
	match: Match,
	path: string,
	leaf: string,
	out: Set<string>
): void {
	if (!validator) return;
	switch (validator.kind) {
		case 'object':
			for (const [key, field] of Object.entries(validator.fields ?? {})) {
				collect(field, match, path ? `${path}.${key}` : key, key, out);
			}
			return;
		case 'array':
			collect(validator.element, match, `${path}[]`, leaf, out);
			return;
		case 'union':
			for (const member of validator.members ?? []) collect(member, match, path, leaf, out);
			return;
		case 'record':
			collect(validator.value, match, `${path}{}`, leaf, out);
			return;
		default:
			if (match(validator, leaf)) out.add(path);
	}
}

/** `table.field` for every schema field `match` accepts. */
function schemaFields(match: Match): string[] {
	const refs: string[] = [];
	const tables = (schema as unknown as { tables: Record<string, { validator: ValidatorJson }> })
		.tables;
	for (const [table, definition] of Object.entries(tables)) {
		const fields = new Set<string>();
		collect(definition.validator, match, '', '', fields);
		for (const field of fields) refs.push(`${table}.${field}`);
	}
	return refs.sort();
}

const referencesTo = (target: string) =>
	schemaFields((validator) => validator.kind === 'id' && validator.tableName === target);

const erasureSource = ['identityPhases', 'mailboxPhases', 'memberPhases', 'phases']
	.map((file) => readFileSync(join(__dirname, '..', 'auth', 'erasure', `${file}.ts`), 'utf8'))
	.join('\n');

/**
 * Tables whose rows the erasure deletes through a shared helper rather than a
 * query of its own (message bodies and counters with their message/mailbox,
 * cached tokens with their account, the deletion-record plumbing).
 */
const DELETED_BY_HELPER = new Set([
	'mailMessageBodies',
	'mailboxUsage',
	'counterScopes',
	'externalMailAccessTokens',
	'userProfiles',
	'memberErasureJobs',
	'userOnboarding',
	'sendReadyNotices',
	'platformAdmins',
]);

describe('member erasure relation registry', () => {
	it('declares a policy for every field in the schema that names a user', () => {
		const declared = MEMBER_RELATIONS.map((r) => `${r.table}.${r.field}`).sort();
		const named = schemaFields(
			(validator, leaf) => validator.kind === 'string' && MEMBER_REFERENCE_FIELD.test(leaf)
		);
		expect(declared).toEqual(named);
	});

	it('declares a policy for every reference to a table the erasure deletes from', () => {
		const parents = tablesErasureDeletesFrom();
		expect(parents.has('mailboxes')).toBe(true);
		for (const parent of parents) {
			const declared = DESCENDANT_RELATIONS.filter((r) => r.parent === parent)
				.map((r) => `${r.table}.${r.field}`)
				.sort();
			expect(declared, `descendants of ${parent}`).toEqual(referencesTo(parent));
		}
	});

	it('declares no descendant of a table the erasure never deletes from', () => {
		const parents = tablesErasureDeletesFrom();
		for (const relation of DESCENDANT_RELATIONS) {
			expect(parents.has(relation.parent), `${relation.parent} is not deleted`).toBe(true);
		}
	});

	it('declares every BetterAuth component table', () => {
		expect(Object.keys(IDENTITY_TABLES).sort()).toEqual(Object.keys(betterAuthTables).sort());
		for (const table of ['user', 'session', 'account', 'passkey', 'twoFactor'] as const) {
			expect(IDENTITY_TABLES[table].action).toBe('delete');
		}
	});

	it('covers the private assistant and uploaded archives', () => {
		const actionOf = (table: string, field: string) =>
			[...MEMBER_RELATIONS, ...DESCENDANT_RELATIONS].find(
				(r) => r.table === table && r.field === field
			)?.action;
		expect(actionOf('aiConversations', 'ownerId')).toBe('delete');
		expect(actionOf('aiMessages', 'ownerId')).toBe('delete');
		expect(actionOf('aiMessages', 'conversationId')).toBe('delete');
		expect(actionOf('mailArchiveImports', 'mailboxId')).toBe('delete');
	});

	it('covers Answer mode: ask sessions everywhere, a personal thread’s catch-up cards', () => {
		const actionOf = (table: string, field: string) =>
			[...MEMBER_RELATIONS, ...DESCENDANT_RELATIONS].find(
				(r) => r.table === table && r.field === field
			)?.action;
		expect(actionOf('answerAskSessions', 'ownerId')).toBe('delete');
		expect(actionOf('answerAskSessions', 'target.draftId')).toBe('delete');
		expect(actionOf('threadCatchUps', 'mailThreadId')).toBe('delete');
	});

	it('has a phase that reads every table it declares deleted', () => {
		for (const table of tablesErasureDeletesFrom()) {
			if (DELETED_BY_HELPER.has(table)) continue;
			expect(erasureSource, `no erasure phase queries ${table}`).toContain(`'${table}'`);
		}
	});

	it('gives every relation a reason', () => {
		for (const relation of [...MEMBER_RELATIONS, ...DESCENDANT_RELATIONS]) {
			expect(relation.why.trim().length, `${relation.table}.${relation.field}`).toBeGreaterThan(0);
		}
		for (const [table, entry] of Object.entries(IDENTITY_TABLES)) {
			expect(entry.why.trim().length, table).toBeGreaterThan(0);
		}
	});
});
