/**
 * The two projections of an external account that decide what reaches the row
 * and what reaches the client (`mail/external/accountShared.ts`):
 *
 *   - `pickConnectionFields` copies exactly the connection columns out of a
 *     connect/rotate mutation's args, never the address, display name, roster,
 *     seed provider or mailbox id those args also carry.
 *   - `toPublicAccountView` is the one account projection a query may return,
 *     and it never carries the credential envelope.
 */

import { describe, it, expect } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import { pickConnectionFields, toPublicAccountView } from '../external/accountShared';

const CONNECTION = {
	imapHost: 'imap.acme.test',
	imapPort: 993,
	isImapSecure: true,
	smtpHost: 'smtp.acme.test',
	smtpPort: 465,
	isSmtpSecure: true,
	imapUsername: 'support@acme.test',
	smtpUsername: 'support@acme.test',
	authMethod: 'oauth2' as const,
	oauthProvider: 'google' as const,
	secretCiphertext: 'ct',
	secretIv: 'iv',
	secretAuthTag: 'tag',
	secretEnvelopeVersion: 1,
};

/** Keys that must never reach an account row from the connect args. */
const NOT_A_COLUMN = ['emailAddress', 'displayName', 'memberUserIds', 'seedProvider', 'mailboxId'];

function forbiddenKeysIn(value: object, forbidden: (key: string) => boolean): string[] {
	return Object.keys(value).filter(forbidden);
}

describe('pickConnectionFields', () => {
	it('copies the connection columns and nothing the connect args carry besides', () => {
		const args = {
			...CONNECTION,
			emailAddress: 'support@acme.test',
			displayName: 'Support',
			memberUserIds: ['user-B'],
			seedProvider: 'gmail',
			mailboxId: 'mailbox-1',
		};
		const picked = pickConnectionFields(args);
		expect(picked).toEqual(CONNECTION);
		expect(forbiddenKeysIn(picked, (k) => NOT_A_COLUMN.includes(k))).toEqual([]);
	});

	it('keeps an absent optional field as an explicit undefined so a rotation clears it', () => {
		const { oauthProvider: _drop, ...passwordRow } = {
			...CONNECTION,
			authMethod: 'password' as const,
		};
		const picked = pickConnectionFields(passwordRow);
		expect(Object.keys(picked)).toContain('oauthProvider');
		expect(picked.oauthProvider).toBeUndefined();
	});
});

describe('toPublicAccountView', () => {
	it('never returns the credential envelope or connect-only fields', () => {
		const account = {
			_id: 'account-1' as Id<'externalMailAccounts'>,
			_creationTime: 0,
			userId: 'user-A',
			organizationId: 'org-1',
			mailboxId: 'mailbox-1' as Id<'mailboxes'>,
			purpose: 'seed',
			seedProvider: 'gmail',
			...CONNECTION,
			status: 'connected',
			lastError: undefined,
			lastSyncAt: 10,
			lastConnectedAt: 5,
			createdAt: 0,
			updatedAt: 0,
		} as Doc<'externalMailAccounts'>;
		const view = toPublicAccountView(account);
		expect(
			forbiddenKeysIn(view, (k) => k.startsWith('secret') || NOT_A_COLUMN.includes(k))
		).toEqual([]);
		expect(view).toMatchObject({
			imapHost: 'imap.acme.test',
			authMethod: 'oauth2',
			oauthProvider: 'google',
			status: 'connected',
			lastSyncAt: 10,
		});
	});
});
