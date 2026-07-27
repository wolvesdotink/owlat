/**
 * Deliverability SEED mailboxes — the connect half of step 1 of the placement
 * probe (`analytics/seedPlacement.ts`).
 *
 * A domain sibling of `mail/externalAccounts.ts` rather than more lines inside
 * it (CONVENTIONS.md — split a feature file at ~500 LOC): a seed shares that
 * file's TABLE, its sealed-credential envelope and its IMAP client, but nothing
 * of its lifecycle. It is never the caller's personal inbox, never syncs into
 * Postbox, and never appears on a personal-external surface.
 *
 * Crypto and the plaintext credential path stay in the `'use node'` sibling
 * `externalAccountsActions.ts`; this file only persists an already-sealed
 * envelope.
 */

import { internalMutation } from '../_generated/server';
import { requireAdminContext } from '../lib/sessionOrganization';
import { provisionMailbox, canonicalAddress, resolveDeliverableMailbox } from './mailbox';
import { insertExternalAccountRow, takeLiveSeedAccounts } from './externalAccountShared';
import { connectFieldsValidator } from './externalAccounts';
import { destinationProviderValidator } from '../delivery/deliverabilityValidators';
import { SEED_ACCOUNTS_PER_ORG_LIMIT } from '@owlat/shared/seedPlacement';
import { throwInvalidInput, throwAlreadyExists } from '../_utils/errors';

/**
 * Connect a DELIVERABILITY SEED mailbox — step 1 of the placement probe.
 *
 * Deliberately the same table, the same sealed-credential envelope and the
 * same IMAP client as every other external account (D4/no second credential
 * model); it differs only in what it is FOR. Unlike `_connectInternal` there
 * is no one-live-per-user guard: an operator connects a handful of seeds, and
 * a seed is not a personal inbox. Zero seed accounts stays a fully supported
 * configuration (D2) — this is opt-in, never a setup step.
 *
 * The provisioned mailbox carries `scope: 'seed'`, which is what keeps the
 * operator's consumer address out of THEIR OWN Postbox: the mailbox row has to
 * name an owning `userId` (there is no other), and without the discriminator
 * `loadAccessibleMailboxes` and `getActiveMailboxForUser` would both read the
 * seed as the connecting admin's personal mailbox.
 *
 * authz: requireAdminContext (a seed is org infrastructure, exactly like a team
 * inbox) — every campaign the org sends will deliver a full copy to it.
 */
export const _connectSeedInternal = internalMutation({
	args: { ...connectFieldsValidator, seedProvider: destinationProviderValidator },
	handler: async (ctx, args) => {
		// Admin floor, for the same reason `_connectSharedInternal` has one: a seed
		// is org infrastructure, and connecting one makes every campaign the org
		// sends deliver a full copy into a mailbox the connecting member controls.
		const s = await requireAdminContext(ctx);
		const address = canonicalAddress(args.emailAddress);
		const [, domain] = address.split('@');
		if (!domain) throwInvalidInput('Invalid email address');

		const existingMailbox = await resolveDeliverableMailbox(ctx, address);
		if (existingMailbox) {
			throwAlreadyExists(`A mailbox for ${address} already exists.`);
		}

		// Refuse the (limit+1)th seed rather than letting the roll-up's bounded
		// read page drop it silently. An operator who connected a seed must be
		// able to trust that it is being measured.
		//
		// Counts LIVE rows through the index (`takeLiveSeedAccounts`), not a
		// bounded page filtered afterwards: disconnecting is a soft status change,
		// so retired rows in a post-filtered page would push the observed count
		// permanently below the cap and disable it outright.
		const liveSeeds = await takeLiveSeedAccounts(
			ctx.db,
			s.activeOrganizationId,
			SEED_ACCOUNTS_PER_ORG_LIMIT
		);
		if (liveSeeds.length >= SEED_ACCOUNTS_PER_ORG_LIMIT) {
			throwInvalidInput(
				`This organization already has the maximum of ${SEED_ACCOUNTS_PER_ORG_LIMIT} seed mailboxes. Disconnect one before connecting another.`
			);
		}

		const now = Date.now();
		const mailboxId = await provisionMailbox(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			address,
			domain,
			displayName: args.emailAddress,
			kind: 'external',
			scope: 'seed',
		});
		const accountId = await insertExternalAccountRow(ctx, {
			userId: s.userId,
			organizationId: s.activeOrganizationId,
			mailboxId,
			address,
			seed: { seedProvider: args.seedProvider },
			auditPrefix: 'deliverability seed ',
			fields: args,
			now,
		});
		return { mailboxId, externalAccountId: accountId };
	},
});
