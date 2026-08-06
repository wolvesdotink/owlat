/**
 * The operator-supplied SNDS configuration, parsed.
 *
 * PURE: strings in, values out. No clock, no database, no Convex function —
 * which is the whole reason it is its own module. Both SNDS sides need these:
 * `sndsPoll.ts` (the action that fetches) and `snds.ts` (the durable mutations)
 * each have to know whether an enrolment exists, which addresses we claim, and
 * how far back a day may reach. Keeping them in the poller made the durable
 * module import the action module — a mutation depending on fetch plumbing
 * purely to read configuration. Both now depend on this, and on nothing else.
 */

import { parsePoolIpsLenient } from '../domains/spf';
import { DAY_MS } from './sndsFeed';
import { startOfDayUtc } from '../lib/clock';

/**
 * How far back a feed row may reach and still be stored.
 *
 * ONE window, TWO enforcement points: the poller pre-filters on it so a day the
 * mutation would refuse never costs a round trip, and the mutation re-checks it
 * because its argument is untrusted. Both compare against a UTC DAY BOUNDARY —
 * every `periodStart` is a UTC midnight, so an edge taken at the current instant
 * would sit mid-day and refuse a day the poller had just decided to send.
 */
export const SNDS_INGEST_MAX_AGE_MS = 14 * DAY_MS;

/** How many feed URLs one deployment may configure. */
export const SNDS_MAX_FEEDS = 8;

/**
 * The oldest `periodStart` storable at `now`, day-aligned.
 *
 * Exported so the poller's pre-filter and the mutation's re-check are the SAME
 * sentence rather than two spellings of it — the two disagreeing by up to a day
 * is exactly how a day gets dispatched and then rejected for no visible reason.
 */
export function oldestStorableDay(now: number): number {
	return startOfDayUtc(now) - SNDS_INGEST_MAX_AGE_MS;
}

/**
 * Parse `SNDS_DATA_FEED_URLS`.
 *
 * The value is a list of Automated Data Access URLs. Each one is a BEARER
 * CAPABILITY to the operator's SNDS data, so it is never logged or returned;
 * only `https` is accepted, and a malformed entry is ignored rather than
 * crashing the poll.
 */
export function parseSndsFeedUrls(raw: string | undefined): string[] {
	const urls: string[] = [];
	for (const entry of (raw ?? '').split(/[,\s]+/)) {
		if (urls.length >= SNDS_MAX_FEEDS) break;
		const candidate = entry.trim();
		if (candidate.length === 0) continue;
		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			continue;
		}
		if (parsed.protocol !== 'https:') continue;
		if (!urls.includes(parsed.toString())) urls.push(parsed.toString());
	}
	return urls;
}

/**
 * The sending IPs this deployment claims, from `MTA_IP_POOLS`.
 *
 * An SNDS key can cover a whole registered range, so a feed may legitimately
 * carry addresses that are not ours. When the operator declares their pool we
 * treat it as an allowlist and drop everything else; when they do not, whatever
 * the key's range covers is stored unattributed — which is why the poller is the
 * only place the claim is enforced, and why `rampPromotionEvidence.ts` reads the
 * stored rows deployment-wide rather than pretending to scope them.
 *
 * The grammar is `domains/spf.ts`'s, read leniently: one parser for one env var,
 * because a typo in the pool must not take the poller down but it also must not
 * mean the poller accepts addresses registration would have refused.
 */
export function parsePoolAllowlist(raw: string | undefined): Set<string> {
	return new Set(parsePoolIpsLenient(raw).ips);
}
