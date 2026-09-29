/**
 * The mailbox half of every external connect: the personal `_connectInternal`,
 * the team-inbox `_connectSharedInternal` and the deliverability seed's
 * `_connectSeedInternal`. Each canonicalises the typed address, refuses one a
 * mailbox already claims, and provisions a `kind='external'` mailbox for the
 * account row `insertExternalAccountRow` then writes.
 *
 * Split in two because the personal path re-opens a retained mailbox between
 * the claim check and provisioning (`findRetainedPersonalAccount`), and the seed
 * path checks its per-org cap there. `provisionExternalMailbox` takes the
 * {@link ClaimedExternalAddress} the check returns, so a connect cannot
 * provision without having asked.
 *
 * Kept out of `accountShared.ts`: provisioning needs `mailbox/identity.ts`,
 * which imports the teardown module that imports `accountShared.ts`.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { extractEmail } from '../../lib/emailAddress';
import { throwAlreadyExists, throwInvalidInput } from '../../_utils/errors';
import { findAddressClaim } from '../mailbox/addressResolution';
import { provisionMailbox } from '../mailbox/identity';

declare const claimed: unique symbol;

/** A canonical address no mailbox claims, as returned by {@link claimExternalAddress}. */
export type ClaimedExternalAddress = {
	readonly address: string;
	readonly domain: string;
	readonly [claimed]: true;
};

/**
 * Canonicalise `emailAddress` and refuse it when it is malformed or a mailbox
 * already claims it under `findAddressClaim`'s rule (any row except a
 * soft-deleted external one). A suspended or soft-deleted hosted mailbox on the
 * address refuses the connect as well as a live one.
 */
export async function claimExternalAddress(
	ctx: MutationCtx,
	emailAddress: string
): Promise<ClaimedExternalAddress> {
	const address = extractEmail(emailAddress);
	const [, domain] = address.split('@');
	if (!domain) throwInvalidInput('Invalid email address');
	if (await findAddressClaim(ctx, address)) {
		throwAlreadyExists(`A mailbox for ${address} already exists.`);
	}
	return { address, domain } as ClaimedExternalAddress;
}

/**
 * Provision the `kind='external'` mailbox for a connect on a claimed address.
 * `scope` is the mailbox's sharing model: undefined for a personal account,
 * 'shared' for a team inbox, 'seed' for a deliverability seed.
 */
export async function provisionExternalMailbox(
	ctx: MutationCtx,
	params: {
		userId: string;
		organizationId: string;
		claim: ClaimedExternalAddress;
		displayName: string;
		scope?: 'shared' | 'seed';
	}
): Promise<Id<'mailboxes'>> {
	return await provisionMailbox(ctx, {
		userId: params.userId,
		organizationId: params.organizationId,
		address: params.claim.address,
		domain: params.claim.domain,
		displayName: params.displayName,
		kind: 'external',
		...(params.scope ? { scope: params.scope } : {}),
	});
}
