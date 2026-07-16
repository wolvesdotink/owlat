import { describe, expect, it } from 'vitest';
import {
	isDraftClassificationScope,
	resolveDraftStrategySelection,
} from '../draftStrategySelections';

type Row = { strategyKind: string };

function fakeCtx(rows: Readonly<Record<string, Row>>) {
	const reads: string[] = [];
	const ctx = {
		db: {
			query: () => ({
				withIndex: (_name: string, apply: (q: unknown) => unknown) => {
					const values: string[] = [];
					const chain = {
						eq: (_field: string, value: string) => {
							values.push(value);
							return chain;
						},
					};
					apply(chain);
					const key = values.join(':');
					reads.push(key);
					return { take: async () => (rows[key] ? [rows[key]] : []) };
				},
			}),
		},
	};
	return { ctx: ctx as never, reads };
}

describe('draft strategy selection precedence', () => {
	it('accepts only host classification categories', () => {
		expect(isDraftClassificationScope('support')).toBe(true);
		expect(isDraftClassificationScope('other')).toBe(true);
		expect(isDraftClassificationScope('unknown_future_value')).toBe(false);
	});
	it('chooses contact before mailbox before classification', async () => {
		const { ctx, reads } = fakeCtx({
			'org:contact:contact-1': { strategyKind: 'plugin.pack.contact' },
			'org:mailbox:mailbox-1': { strategyKind: 'plugin.pack.mailbox' },
			'org:classification:support': { strategyKind: 'plugin.pack.classification' },
		});
		await expect(
			resolveDraftStrategySelection(ctx, 'org', {
				contactId: 'contact-1',
				mailboxId: 'mailbox-1',
				classification: 'support',
			})
		).resolves.toBe('plugin.pack.contact');
		expect(reads).toEqual(['org:contact:contact-1']);
	});

	it('falls through absent scopes deterministically', async () => {
		const { ctx, reads } = fakeCtx({
			'org:classification:other': { strategyKind: 'plugin.pack.other' },
		});
		await expect(
			resolveDraftStrategySelection(ctx, 'org', { mailboxId: 'mailbox-1', classification: 'other' })
		).resolves.toBe('plugin.pack.other');
		expect(reads).toEqual(['org:mailbox:mailbox-1', 'org:classification:other']);
	});

	it('returns default when no scope is configured', async () => {
		const { ctx } = fakeCtx({});
		await expect(
			resolveDraftStrategySelection(ctx, 'org', { classification: 'support' })
		).resolves.toBe('default');
	});

	it('never reads another organization and preserves stale kinds for safe runtime fallback', async () => {
		const { ctx, reads } = fakeCtx({
			'other:contact:contact-1': { strategyKind: 'plugin.other.leak' },
			'org:contact:contact-1': { strategyKind: 'plugin.retired.missing' },
		});
		await expect(
			resolveDraftStrategySelection(ctx, 'org', {
				contactId: 'contact-1',
				classification: 'support',
			})
		).resolves.toBe('plugin.retired.missing');
		expect(reads).toEqual(['org:contact:contact-1']);
	});
});
