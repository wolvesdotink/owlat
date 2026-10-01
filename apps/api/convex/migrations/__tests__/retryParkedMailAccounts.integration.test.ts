import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import type { Doc } from '../../_generated/dataModel';

const migration = internal.migrations['0056_retry_parked_mail_accounts'];

type AccountStatus = Doc<'externalMailAccounts'>['status'];

describe('0056 retry parked mail accounts', () => {
	it('makes every parked mailbox connectable again, seeds and healthy rows untouched', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const now = Date.now();
			const insert = async (status: AccountStatus, purpose?: 'seed') => {
				const mailboxId = await ctx.db.insert('mailboxes', {
					userId: 'user-1',
					organizationId: 'org-1',
					address: `${status}-${purpose ?? 'mail'}@owlat.test`,
					domain: 'owlat.test',
					kind: 'external',
					status: 'active',
					usedBytes: 0,
					uidValidity: now,
					createdAt: now,
					updatedAt: now,
				});
				return ctx.db.insert('externalMailAccounts', {
					userId: 'user-1',
					organizationId: 'org-1',
					mailboxId,
					...(purpose ? { purpose } : {}),
					imapHost: 'imap.example',
					imapPort: 993,
					isImapSecure: true,
					smtpHost: 'smtp.example',
					smtpPort: 465,
					isSmtpSecure: true,
					authMethod: 'password',
					imapUsername: `${status}@owlat.test`,
					secretCiphertext: 'x',
					secretIv: 'x',
					secretAuthTag: 'x',
					secretEnvelopeVersion: 1,
					status,
					lastError: status === 'connected' ? undefined : 'Command failed',
					createdAt: now,
					updatedAt: now,
				});
			};
			return {
				parked: await insert('auth_error'),
				parkedSeed: await insert('auth_error', 'seed'),
				connected: await insert('connected'),
			};
		});

		expect(await t.mutation(migration.run, {})).toEqual({ retried: 1 });

		const rows = await t.run(async (ctx) => ({
			parked: await ctx.db.get(ids.parked),
			parkedSeed: await ctx.db.get(ids.parkedSeed),
			connected: await ctx.db.get(ids.connected),
		}));
		expect(rows.parked).toMatchObject({ status: 'pending' });
		expect(rows.parked?.lastError).toBeUndefined();
		expect(rows.parkedSeed?.status).toBe('auth_error');
		expect(rows.connected?.status).toBe('connected');

		expect(await t.mutation(migration.run, {})).toEqual({ retried: 0 });
	});
});
