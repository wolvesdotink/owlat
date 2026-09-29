import { describe, expect, it } from 'vitest';
import { seedPostboxMailboxId } from '../postboxMailboxSeed';

const rows = (...ids: string[]) => ids.map((mailboxId) => ({ mailboxId }));

describe('seedPostboxMailboxId', () => {
	it('waits while the accessible mailboxes are unknown, persisted choice or not', () => {
		expect(
			seedPostboxMailboxId({ requested: null, persisted: 'mb-1', accessible: undefined })
		).toBe(null);
	});

	it('seeds the persisted choice once the accessible rows vouch for it', () => {
		expect(
			seedPostboxMailboxId({ requested: null, persisted: 'mb-2', accessible: rows('mb-1', 'mb-2') })
		).toBe('mb-2');
	});

	it('does not trust a persisted id outside the accessible set, and waits instead', () => {
		// A suspended, deleted or foreign mailbox: identity.list decides.
		expect(
			seedPostboxMailboxId({ requested: null, persisted: 'gone', accessible: rows('mb-1') })
		).toBe(null);
	});

	it('takes the first accessible mailbox when nothing is persisted', () => {
		expect(
			seedPostboxMailboxId({ requested: null, persisted: null, accessible: rows('mb-1', 'mb-2') })
		).toBe('mb-1');
		expect(seedPostboxMailboxId({ requested: null, persisted: null, accessible: [] })).toBe(null);
	});

	it('prefers a ?mailbox= deep link the viewer can read over the persisted choice', () => {
		expect(
			seedPostboxMailboxId({
				requested: 'mb-2',
				persisted: 'mb-1',
				accessible: rows('mb-1', 'mb-2'),
			})
		).toBe('mb-2');
		expect(
			seedPostboxMailboxId({ requested: 'nope', persisted: 'mb-1', accessible: rows('mb-1') })
		).toBe(null);
	});
});
