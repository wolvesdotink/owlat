/**
 * The search clause is declared twice: once as the web parser's output type
 * (`MailSearchClause` in `@owlat/shared/mailSearch`) and once as the query's
 * argument validator (`searchClauseValidator`, whose `Infer` is
 * `SearchClause`). Both callers spread the parsed object into the query args,
 * and TypeScript does not excess-check spread members, so an operator added to
 * the parser without a backend field would compile and then fail at runtime
 * with an argument validation error. These assertions make that drift a type
 * error instead.
 *
 * The check is type-level, so it is enforced by `turbo typecheck` (this file is
 * part of the Convex tsconfig); the runtime assertions only pin the case
 * folding the server applies on the way in.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MailSearchClause, MailSearchQuery } from '@owlat/shared/mailSearch';
import { normalizeClause, type SearchClause } from '../mailbox/searchClause';

describe('SearchClause', () => {
	it('is the same shape as the parser output', () => {
		expectTypeOf<SearchClause>().toEqualTypeOf<MailSearchClause>();
		expectTypeOf<MailSearchQuery['or']>().toEqualTypeOf<SearchClause[] | undefined>();
	});
});

describe('normalizeClause', () => {
	it('lowercases every operand the parser lowercases', () => {
		const normalized = normalizeClause({
			text: 'Quarterly Report',
			phrases: ['Exact Phrase'],
			from: 'Alice@Example.com',
			to: 'Bob@Example.com',
			cc: 'Legal',
			bcc: 'Archive',
			subject: 'Invoice',
			filename: 'Deck.KEY',
			folderRole: 'INBOX',
			labelName: 'Billing',
			flagSeen: false,
			largerThan: 5,
			not: {
				text: ['Draft'],
				from: ['Noise@Example.com'],
				to: ['X'],
				cc: ['Y'],
				bcc: ['Z'],
				subject: ['Re'],
				filename: ['Old.PDF'],
				labelName: ['Muted'],
				folderRole: ['SPAM'],
			},
		});
		expect(normalized).toEqual({
			// Free text goes to the search index as typed.
			text: 'Quarterly Report',
			phrases: ['exact phrase'],
			from: 'alice@example.com',
			to: 'bob@example.com',
			cc: 'legal',
			bcc: 'archive',
			subject: 'invoice',
			filename: 'deck.key',
			folderRole: 'inbox',
			labelName: 'billing',
			flagSeen: false,
			largerThan: 5,
			not: {
				text: ['draft'],
				from: ['noise@example.com'],
				to: ['x'],
				cc: ['y'],
				bcc: ['z'],
				subject: ['re'],
				filename: ['old.pdf'],
				labelName: ['muted'],
				folderRole: ['spam'],
			},
		});
	});

	it('adds no operands a clause did not carry', () => {
		const normalized = normalizeClause({ text: '', from: 'A' });
		expect(Object.entries(normalized).filter(([, value]) => value !== undefined)).toEqual([
			['text', ''],
			['from', 'a'],
		]);
	});
});
