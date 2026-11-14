/**
 * The pre-flight's question about the built-in mail server: can it deliver a
 * campaign right now?
 *
 * "A provider is configured" only means its environment variables are set. On
 * a fresh host with outbound port 25 blocked, or with every sending IP held by
 * a blocklist, a campaign would pass that check, enter `sending` and sit in
 * the MTA queue until the queue expires it. The Delivery hub already says
 * "blocked" for those hosts; this module lets the pre-flight say the same.
 *
 * It reads the hub's own classification (`mtaInfrastructureState`, the shared
 * `sendingIpPosture`), so the gate and the hub cannot disagree about a held
 * address or an unreachable server. Only what stops delivery outright refuses:
 * the server does not answer, no sending IP of the campaign pool can reach
 * port 25, or every one of them is held. Other degradations (a TLS
 * certificate warning, a slow DNS resolver) stay warnings on the hub.
 *
 * FAIL OPEN. A missing or stale snapshot never refuses, as the capacity gate
 * does with capacity it cannot measure: a sync that stopped says nothing about
 * the server, and refusing on no evidence would block every campaign on an
 * instance whose health cron is merely late.
 */

import type { Infer } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { sendingIpPosture } from '@owlat/shared/ipReadiness';
import { messageTypeTransportKinds } from '../lib/sendProviders/capability';
import { OWN_ARM_TRANSPORT_KIND } from '../lib/sendProviders/strategies/adaptive_mix';
import { readInstanceCounter } from '../lib/instanceCounters';
import { mtaInfrastructureState } from '../delivery/health';
import { MTA_HEALTH_MAX_AGE_MS } from '../delivery/mtaHealthFreshness';
import type { mtaHealthSnapshotValidator } from '../schema/instance';

type MtaHealthSnapshot = Infer<typeof mtaHealthSnapshotValidator>;

/**
 * A synced IP list older than this says nothing about the addresses now. The
 * warm-up sync runs every five minutes, so this allows several missed syncs.
 */
export const WARMING_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

/** Why the built-in mail server cannot deliver a campaign right now. */
export type MailServerBlock = 'unreachable' | 'port25Blocked' | 'allIpsHeld';

type WarmingFacts = Pick<Doc<'warmingState'>, 'ips' | 'pools' | 'syncedAt'>;

/**
 * The addresses the campaign pool sends from: the MTA's own pool list when it
 * reports one, else every address it probed (an MTA that lists no campaign
 * address sends campaigns from all of them).
 */
function campaignPoolAddresses(snapshotIps: readonly string[], warming: WarmingFacts | null) {
	const listed = warming?.pools?.campaign ?? [];
	const inPool = snapshotIps.filter((ip) => listed.includes(ip));
	return inPool.length > 0 ? inPool : snapshotIps;
}

/**
 * Pure: whether a fresh health picture of the built-in MTA stops campaign
 * delivery, and why; `null` when it does not or when the picture is stale.
 */
export function campaignMailServerBlock(input: {
	snapshot: MtaHealthSnapshot | null | undefined;
	warming: WarmingFacts | null;
	now: number;
}): MailServerBlock | null {
	const { snapshot, warming, now } = input;
	const state = mtaInfrastructureState(snapshot, now);
	if (state === 'unreachable') return 'unreachable';
	if (!snapshot || state === 'stale' || state === 'unchecked') return null;

	const outbound = snapshot.smtpOutbound;
	if (outbound && now - outbound.checkedAt <= MTA_HEALTH_MAX_AGE_MS && outbound.ips.length > 0) {
		const pool = new Set(
			campaignPoolAddresses(
				outbound.ips.map((ip) => ip.ip),
				warming
			)
		);
		const probed = outbound.ips.filter((ip) => pool.has(ip.ip));
		if (probed.length > 0 && probed.every((ip) => ip.status === 'failed')) return 'port25Blocked';
	}

	if (snapshot.isAllIpsBlocked === true) return 'allIpsHeld';
	if (warming && now - warming.syncedAt <= WARMING_SNAPSHOT_MAX_AGE_MS) {
		if (sendingIpPosture(warming.ips, 'campaign', warming.pools) === 'all_held') {
			return 'allIpsHeld';
		}
	}
	return null;
}

/**
 * {@link campaignMailServerBlock} for this deployment, or `null` when the
 * campaign route does not reach the built-in MTA at all (relay and API
 * providers have their own health, which this gate does not judge).
 */
export async function assessCampaignMailServer(
	ctx: QueryCtx | MutationCtx,
	now: number
): Promise<MailServerBlock | null> {
	const routes = await ctx.db.query('providerRoutes').collect(); // bounded: one row per message type
	const kinds = await messageTypeTransportKinds(ctx, routes, 'campaign');
	if (!kinds.includes(OWN_ARM_TRANSPORT_KIND)) return null;
	const { mtaHealth } = await readInstanceCounter(ctx.db, 'mtaHealth');
	const warming = await ctx.db.query('warmingState').first();
	return campaignMailServerBlock({ snapshot: mtaHealth, warming, now });
}
