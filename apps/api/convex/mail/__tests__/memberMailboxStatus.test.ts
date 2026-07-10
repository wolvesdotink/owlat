/**
 * Pure-helper coverage for the members-table mailbox-status derivation
 * (mail/memberMailboxStatus.ts): `deriveMemberMailboxStatus` maps a user's
 * mailbox rows to a single
 * 'hosted' | 'external' | 'external-instance' | 'none' discriminator.
 */
import { describe, it, expect } from 'vitest';
import { deriveMemberMailboxStatus } from '../memberMailboxStatus';
import type { Doc } from '../../_generated/dataModel';

function mailbox(overrides: Partial<Doc<'mailboxes'>> = {}): Doc<'mailboxes'> {
	return {
		_id: 'mailbox_1' as Doc<'mailboxes'>['_id'],
		_creationTime: 0,
		userId: 'user_1',
		organizationId: 'org_1',
		address: 'a@example.com',
		domain: 'example.com',
		status: 'active',
		usedBytes: 0,
		uidValidity: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as Doc<'mailboxes'>;
}

describe('deriveMemberMailboxStatus', () => {
	it('returns "none" for an empty set of rows', () => {
		expect(deriveMemberMailboxStatus([])).toBe('none');
	});

	it('treats a hosted mailbox (kind="hosted") as hosted', () => {
		expect(deriveMemberMailboxStatus([mailbox({ kind: 'hosted' })])).toBe('hosted');
	});

	it('defaults undefined kind to hosted (back-compat for pre-external rows)', () => {
		expect(deriveMemberMailboxStatus([mailbox({ kind: undefined })])).toBe('hosted');
	});

	it('reports external when the only mailbox is a connected external account', () => {
		expect(deriveMemberMailboxStatus([mailbox({ kind: 'external' })])).toBe('external');
	});

	it('reports external-instance for an external mailbox switched to instance sending', () => {
		expect(
			deriveMemberMailboxStatus([mailbox({ kind: 'external', outboundPreference: 'instance' })])
		).toBe('external-instance');
	});

	it('keeps plain external when the external mailbox still sends through its own server', () => {
		expect(
			deriveMemberMailboxStatus([mailbox({ kind: 'external', outboundPreference: 'external' })])
		).toBe('external');
	});

	it('lets a hosted mailbox win over an external one regardless of order', () => {
		expect(
			deriveMemberMailboxStatus([mailbox({ kind: 'external' }), mailbox({ kind: 'hosted' })])
		).toBe('hosted');
		expect(
			deriveMemberMailboxStatus([mailbox({ kind: 'hosted' }), mailbox({ kind: 'external' })])
		).toBe('hosted');
	});

	it('excludes shared (team) inboxes — scope="shared" never counts', () => {
		expect(deriveMemberMailboxStatus([mailbox({ scope: 'shared', kind: 'hosted' })])).toBe('none');
		expect(deriveMemberMailboxStatus([mailbox({ scope: 'shared', kind: 'external' })])).toBe(
			'none'
		);
	});

	it('treats undefined scope as personal (back-compat for pre-shared-inbox rows)', () => {
		expect(deriveMemberMailboxStatus([mailbox({ scope: undefined, kind: 'hosted' })])).toBe(
			'hosted'
		);
	});

	it('skips non-active rows (suspended / deleted)', () => {
		expect(deriveMemberMailboxStatus([mailbox({ status: 'suspended', kind: 'hosted' })])).toBe(
			'none'
		);
		expect(deriveMemberMailboxStatus([mailbox({ status: 'deleted', kind: 'external' })])).toBe(
			'none'
		);
	});

	it('ignores a suspended hosted row and reports the active external one', () => {
		expect(
			deriveMemberMailboxStatus([
				mailbox({ status: 'suspended', kind: 'hosted' }),
				mailbox({ status: 'active', kind: 'external' }),
			])
		).toBe('external');
	});
});
