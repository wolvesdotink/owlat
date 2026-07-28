/**
 * Seed MAILBOX ACCOUNTS — the operator-owned consumer inboxes gate 5 measures.
 *
 * A domain sibling of `analytics/seedPlacement.ts` (CONVENTIONS' ~500 LOC
 * guideline): that module owns the probe LEDGER and the roll-up, this one owns
 * the ACCOUNTS the probes are addressed to — the projection every caller reads
 * them through, and the rotation nudge that keeps them worth measuring.
 *
 * Plain functions rather than Convex registrations: every caller is a mutation
 * or query in this same deployment.
 *
 * SECURITY. A seed's credentials are the SAME sealed envelope every other
 * external account uses. Nothing here reads, returns, or logs one: the
 * projection below is the only shape a seed account leaves this module in.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { SEED_ACCOUNTS_PER_ORG_LIMIT, shouldRemindSeedRotation } from '@owlat/shared/seedPlacement';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	seedAgeDays,
	seedProviderOf,
	takeConnectableSeedAccounts,
	takeLiveSeedAccounts,
} from '../mail/externalAccountShared';
import { recordAuditLog } from '../lib/auditLog';

/**
 * The seed mailboxes of an org. Projection is deliberate: no ciphertext, no
 * IV, no auth tag, no username, no host — a seed account's credentials never
 * leave the sealed envelope the mail-sync worker already owns.
 */
export interface SeedAccountView {
	accountId: Id<'externalMailAccounts'>;
	provider: DestinationProviderKey;
	address: string;
	connectedAt: number;
	rotationReminderDue: boolean;
}

function toSeedAccountView(
	account: Doc<'externalMailAccounts'>,
	address: string,
	now: number
): SeedAccountView {
	return {
		accountId: account._id,
		provider: seedProviderOf(account),
		address,
		connectedAt: account.createdAt,
		rotationReminderDue: shouldRemindSeedRotation({
			connectedAt: account.createdAt,
			lastAcknowledgedAt: account.seedRotationAcknowledgedAt,
			now,
		}),
	};
}

/**
 * The org's seed mailboxes, projected.
 *
 * `reach: 'live'` is every seed the operator still owns — the honest
 * denominator for the roll-up and for the connect cap, `auth_error` seeds
 * included. `reach: 'connectable'` is the strictly smaller set the POLLER will
 * walk, and it is the only set anything is allowed to MAIL: a shadow copy to a
 * seed whose credentials expired is real volume against the warming cap that
 * can never be observed, plus a ledger row that sits unclassified for the whole
 * retention window.
 */
export async function loadSeedAccounts(
	db: DatabaseReader,
	organizationId: string,
	now: number,
	reach: 'live' | 'connectable' = 'live'
): Promise<SeedAccountView[]> {
	// NOT a silent truncation: `mail/externalAccountsSeed.ts` refuses the
	// (limit+1)th LIVE seed at CONNECT time and this read selects through the
	// same index, so the page can only ever be short of the cap. A seed the
	// operator connected is always measured.
	const rows =
		reach === 'connectable'
			? await takeConnectableSeedAccounts(db, organizationId, SEED_ACCOUNTS_PER_ORG_LIMIT)
			: await takeLiveSeedAccounts(db, organizationId, SEED_ACCOUNTS_PER_ORG_LIMIT);
	const views: SeedAccountView[] = [];
	for (const row of rows) {
		// `imapUsername` is the LOGIN, which for several providers is not an email
		// address at all. The deliverable address is the linked mailbox's.
		const mailbox = await db.get(row.mailboxId);
		if (!mailbox) continue;
		views.push(toSeedAccountView(row, mailbox.address, now));
	}
	return views;
}

/**
 * SEED COVERAGE as one boolean: does this org own a seed mailbox at all?
 *
 * The question the measurement screen asks is not "how are the probes doing" but
 * "is there an instrument here", and that is answered by ONE row through the
 * same index `loadSeedAccounts` selects through — no observation expansion, no
 * roll-up, no per-account mailbox fan-out. It reads the LIVE set for the same
 * reason the roll-up does: an `auth_error` seed is still an instrument the
 * operator owns, and telling them to "add seed mailboxes" when they have some
 * that need reconnecting is the wrong sentence.
 *
 * Absence is a SUPPORTED CONFIGURATION (plan D2): `false` lowers measurement
 * confidence and offers an improvement, and does nothing else.
 */
export async function hasSeedAccounts(
	db: DatabaseReader,
	organizationId: string
): Promise<boolean> {
	return (await takeLiveSeedAccounts(db, organizationId, 1)).length > 0;
}

/**
 * EMIT the "rotate this seed" nudge into a log a human actually reads.
 *
 * THREE earlier shapes were wrong, and the fix has to hold all three properties
 * at once. The first had the sweep clear a reminder flag and deliver nothing.
 * The second delivered into `mailAuditLog` — a table with no reader anywhere in
 * the product except the retention sweep that deletes from it — and then
 * stamped the flag the roll-up derives due-ness from, so within one 15-minute
 * tick of `rotationRemindersDue` ever becoming non-zero it was back to zero for
 * another 90 days. The third made the artifact readable and durable but left
 * the CALL coupled to IMAP probe work, so the nudge could only be offered to a
 * seed that happened to have an outstanding probe at that instant: a 90-day-old
 * seed on a deployment between campaigns, or one sitting in `auth_error` — the
 * seed most in need of rotating — never produced one.
 *
 * So, in order: the artifact goes through `recordAuditLog` into `auditLogs`,
 * which `auditLogs.list` surfaces org-scoped to admins — a query the product
 * really exposes. Due-ness runs off `seedRotationAcknowledgedAt`, which ONLY an
 * operator writes (`mail/externalAccountsSeed.acknowledgeSeedRotation`);
 * `seedRotationRemindedAt` survives purely as this function's de-duplication
 * stamp, so a repeated sweep cannot write one audit row per tick and cannot
 * silence the nudge either. And the caller is `analytics/seedRotationSweep.ts`,
 * a Convex cron that pages every seed account regardless of status and needs no
 * mailbox, no credential and no worker: rotation is a pure timestamp decision.
 *
 * A plain function rather than a mutation because its one caller is a mutation
 * in the same deployment; there is no worker on the other side of the boundary
 * any more, so an org argument to re-check would be an argument nobody supplies.
 *
 * D2: advisory only. It never blocks a send, a promotion, or a screen, and it
 * is not a "setup incomplete" nag — a seed that is never rotated keeps being
 * measured, it just measures less well.
 */
export async function emitSeedRotationReminderFor(
	ctx: MutationCtx,
	account: Doc<'externalMailAccounts'>,
	now: number
): Promise<boolean> {
	if (account.purpose !== 'seed') return false;
	const due = shouldRemindSeedRotation({
		connectedAt: account.createdAt,
		lastAcknowledgedAt: account.seedRotationAcknowledgedAt,
		now,
	});
	if (!due) return false;
	// One row per un-acknowledged cycle, not one per sweep tick. A stamp older
	// than the acknowledgement it follows belongs to a previous cycle.
	const cycleStart = account.seedRotationAcknowledgedAt ?? account.createdAt;
	const remindedAt = account.seedRotationRemindedAt;
	if (remindedAt !== undefined && remindedAt >= cycleStart) return false;

	// Provider + age only. No address, no credential, no mailbox contents.
	await recordAuditLog(ctx, {
		userId: 'system',
		organizationId: account.organizationId,
		action: 'seed_mailbox.rotation_reminder',
		resource: 'seed_mailbox',
		resourceId: account._id,
		details: {
			provider: seedProviderOf(account),
			ageDays: seedAgeDays(account.createdAt, now),
		},
	});
	// De-duplication only: this stamp does NOT feed `shouldRemindSeedRotation`.
	await ctx.db.patch(account._id, {
		seedRotationRemindedAt: now,
		updatedAt: now,
	});
	return true;
}
