/**
 * Re-register a verified sending domain whose DKIM key the MTA no longer has.
 *
 * The private keys live only in the MTA's Redis. When it is lost (a restore of
 * Convex without Redis, `docker compose down -v`), the MTA reports the domain's
 * held mail with the cause `no_key` while this side still shows the domain as
 * verified. Left alone, the domain would stay verified forever with nothing to
 * sign for it.
 *
 * The way back is the lifecycle's own regeneration (`verified → registering`),
 * the same transition the Domains page's retry runs. The MTA never overwrites a
 * key, so with none left it generates a new one under a NEW selector, and the
 * domain lands in `pending` with that record to publish. The old selector's
 * record in DNS no longer matches anything, so reusing it is impossible by
 * construction. Held mail keeps waiting until the MTA sees the new record.
 *
 * Only `no_key` triggers it. A key that does not open (`unreadable`) means a
 * different `MTA_SECRET`, which restoring the secret fixes without new DNS; the
 * other causes are not about a missing key at all.
 */

import type { Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { transitionDomain } from '../domains/lifecycle';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from '../domains/providers';
import type { mtaHealthSnapshotValidator } from '../schema/instance';

type Snapshot = Infer<typeof mtaHealthSnapshotValidator>;

/** The lifecycle's audit tag for this caller (`system:` marks internal callers). */
const LIFECYCLE_USER_KEY_RECOVERY = 'system:dkim-key-recovery';

export async function regenerateDomainsWithLostKeys(
	ctx: MutationCtx,
	snapshot: Snapshot
): Promise<string[]> {
	const regenerated: string[] = [];
	for (const held of snapshot.dkimSigningHeld ?? []) {
		if (held.cause !== 'no_key') continue;
		const domain = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', held.domain))
			.first();
		if (
			!domain ||
			domain.status !== 'verified' ||
			domain.providerType !== OWN_SENDING_DOMAIN_PROVIDER_KIND
		)
			continue;
		const outcome = await transitionDomain(
			ctx,
			domain._id,
			{ to: 'registering', at: snapshot.observedAt },
			LIFECYCLE_USER_KEY_RECOVERY
		);
		if (outcome.ok) regenerated.push(domain.domain);
	}
	return regenerated;
}
