/**
 * Shared persistence helpers for external mail accounts — the pieces the
 * PERSONAL lifecycle (`mail/externalAccounts.ts`) and the SHARED team-inbox
 * lifecycle (`mail/externalSharedInbox.ts`) both write through, extracted here so
 * the two connect/rotate paths can never drift on the credential row shape.
 *
 * These are plain helpers (they take a `MutationCtx`/account row), not registered
 * Convex functions — the callers own the surrounding authz + side effects
 * (mailbox re-activation, audit prefixes) that differ between personal and shared.
 */

import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * The account statuses a worker should hold (or retry) a connection for.
 *
 * `auth_error` is excluded — it waits on the user to re-enter credentials — and
 * so is `disconnected`. Declared once because BOTH sweeps select on it: the
 * inbound AccountManager's `listConnectableAccounts` and the deliverability
 * prober's seed sweep (`analytics/seedProbePoller.ts`). Two copies behind a
 * "these must agree" comment is the drift this constant removes.
 */
export const CONNECTABLE_ACCOUNT_STATUSES = ['pending', 'connected', 'error'] as const;

export type ConnectableAccountStatus = (typeof CONNECTABLE_ACCOUNT_STATUSES)[number];

/**
 * Every account status that is NOT retired — i.e. a row the operator still owns
 * and expects to be counted. Wider than `CONNECTABLE_ACCOUNT_STATUSES`:
 * `auth_error` is a seed the operator has to re-authenticate, not a seed they
 * removed, and it must still occupy a slot against the per-org cap.
 */
const LIVE_ACCOUNT_STATUSES = ['pending', 'connected', 'auth_error', 'error'] as const;

/**
 * The org's LIVE seed accounts, up to `max` rows.
 *
 * Selects status THROUGH the `by_org_purpose_and_status` index rather than
 * filtering a bounded page afterwards. Disconnecting is a soft status change
 * (the row stays), so a post-filter is wrong in both directions: the connect
 * cap would under-count and stop refusing, and the roll-up would drop live
 * seeds off the end of its page. One bounded read per live status; the whole
 * walk is capped at `max` rows.
 */
export async function takeLiveSeedAccounts(
	db: DatabaseReader,
	organizationId: string,
	max: number
): Promise<Doc<'externalMailAccounts'>[]> {
	const rows: Doc<'externalMailAccounts'>[] = [];
	for (const status of LIVE_ACCOUNT_STATUSES) {
		const remaining = max - rows.length;
		if (remaining <= 0) break;
		const page = await db
			.query('externalMailAccounts')
			.withIndex('by_org_purpose_and_status', (q) =>
				q.eq('organizationId', organizationId).eq('purpose', 'seed').eq('status', status)
			)
			.take(remaining);
		rows.push(...page);
	}
	return rows;
}

/**
 * The non-secret IMAP/SMTP settings + the encrypted-password envelope that every
 * external-account write persists — the single source of truth for the row's
 * credential shape, so adding a field (e.g. an `oauth` authMethod) is one edit
 * here instead of a shotgun across the insert + both rotation patches.
 */
export type ExternalConnectFields = {
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
	authMethod: 'password';
	imapUsername: string;
	smtpUsername?: string;
	secretCiphertext: string;
	secretIv: string;
	secretAuthTag: string;
	secretEnvelopeVersion: number;
};

/**
 * Insert one `externalMailAccounts` row from the encrypted-envelope connect
 * fields, link it back onto the mailbox (`externalAccountId`), and emit the
 * `external_account.connected` audit event. Shared by BOTH connect paths — the
 * personal `_connectInternal` and the shared-team-inbox `_connectSharedInternal`
 * — so the twin paths can never drift on the row shape, the mailbox back-link, or
 * the audit trail. `scope` is `undefined` for a personal 1:1 account and
 * `'shared'` for a team inbox (the discriminator that keeps a team inbox out of
 * every personal-external surface); `auditPrefix` tags the audit detail line.
 */
export async function insertExternalAccountRow(
	ctx: MutationCtx,
	params: {
		userId: string;
		organizationId: string;
		mailboxId: Id<'mailboxes'>;
		address: string;
		scope?: 'shared';
		/** Deliverability SEED mailbox (not a user inbox). Tagged at connect time. */
		seed?: { seedProvider: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other' };
		auditPrefix?: string;
		fields: ExternalConnectFields;
		now: number;
	}
): Promise<Id<'externalMailAccounts'>> {
	const { fields, now } = params;
	const accountId = await ctx.db.insert('externalMailAccounts', {
		userId: params.userId,
		organizationId: params.organizationId,
		mailboxId: params.mailboxId,
		...(params.scope ? { scope: params.scope } : {}),
		...(params.seed ? { purpose: 'seed' as const, seedProvider: params.seed.seedProvider } : {}),
		imapHost: fields.imapHost,
		imapPort: fields.imapPort,
		isImapSecure: fields.isImapSecure,
		smtpHost: fields.smtpHost,
		smtpPort: fields.smtpPort,
		isSmtpSecure: fields.isSmtpSecure,
		authMethod: fields.authMethod,
		imapUsername: fields.imapUsername,
		smtpUsername: fields.smtpUsername,
		secretCiphertext: fields.secretCiphertext,
		secretIv: fields.secretIv,
		secretAuthTag: fields.secretAuthTag,
		secretEnvelopeVersion: fields.secretEnvelopeVersion,
		status: 'pending',
		createdAt: now,
		updatedAt: now,
	});
	await ctx.db.patch(params.mailboxId, { externalAccountId: accountId, updatedAt: now });
	await ctx.db.insert('mailAuditLog', {
		mailboxId: params.mailboxId,
		event: 'external_account.connected',
		details: `${params.auditPrefix ?? ''}${params.address} (imap ${fields.imapHost}:${fields.imapPort}, smtp ${fields.smtpHost}:${fields.smtpPort})`,
		occurredAt: now,
	});
	return accountId;
}

/**
 * Rotate the credential + connection settings on an existing external-account row
 * and reset it to `pending` so the mail-sync worker re-validates with the new
 * credentials on its next pass. Shared by the personal `_updateCredentialsInternal`
 * and the shared-team-inbox `_updateCredentialsSharedInternal`, so the 13-field
 * credential patch can never drift between the two twins. Callers own any
 * surrounding side effects (mailbox re-activation, the shared audit event) that
 * differ between the personal and shared paths.
 */
export async function applyCredentialRotation(
	ctx: MutationCtx,
	accountId: Id<'externalMailAccounts'>,
	fields: ExternalConnectFields,
	now: number
): Promise<void> {
	await ctx.db.patch(accountId, {
		imapHost: fields.imapHost,
		imapPort: fields.imapPort,
		isImapSecure: fields.isImapSecure,
		smtpHost: fields.smtpHost,
		smtpPort: fields.smtpPort,
		isSmtpSecure: fields.isSmtpSecure,
		authMethod: fields.authMethod,
		imapUsername: fields.imapUsername,
		smtpUsername: fields.smtpUsername,
		secretCiphertext: fields.secretCiphertext,
		secretIv: fields.secretIv,
		secretAuthTag: fields.secretAuthTag,
		secretEnvelopeVersion: fields.secretEnvelopeVersion,
		// Reset to pending so the worker re-validates with the new creds.
		status: 'pending',
		lastError: undefined,
		updatedAt: now,
	});
}
