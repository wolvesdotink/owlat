import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import type { HealthTone } from './healthTone';

export type DnsblAccessView = FunctionReturnType<typeof api.delivery.dnsblAccess.get>;
type SpamhausKeyResult = FunctionReturnType<typeof api.delivery.dnsblAccess.setSpamhausKey>;

/**
 * The Blocklist lookups card's wording, as catalog KEYS: this module is module
 * scope and never calls `useI18n`, so `BlocklistLookupsCard.vue` is the render
 * boundary that turns them into sentences.
 */

type SpamhausState = Extract<DnsblAccessView, { status: 'ready' }>['access']['spamhaus'];
type KeyRejection = Extract<SpamhausKeyResult, { ok: false }>['reason'];

const PREFIX = 'components.delivery.blocklistLookups';

/** The status chip: whether Spamhaus answered the last sweep, and if not, why. */
export function blocklistLookupsStatus(view: DnsblAccessView | null): {
	tone: HealthTone;
	label: string;
} {
	if (!view || view.status === 'unavailable') {
		return { tone: 'neutral', label: `${PREFIX}.status.unavailable` };
	}
	const spamhaus: SpamhausState = view.access.spamhaus;
	if (spamhaus.status === 'pending') return { tone: 'neutral', label: `${PREFIX}.status.pending` };
	if (spamhaus.status === 'ok') return { tone: 'success', label: `${PREFIX}.status.ok` };
	return {
		tone: 'error',
		label: `${PREFIX}.status.${spamhaus.reason ?? 'resolver_unreachable'}`,
	};
}

/**
 * Which resolver the lookups use. A configured built-in resolver that did not
 * answer the last sweep is called out, because the refusal the card reports
 * then came from the server's own resolver, and restarting `dns-resolver` —
 * not a DQS key — may be the fix.
 */
export function blocklistResolverLabel(
	resolver: Extract<DnsblAccessView, { status: 'ready' }>['access']['resolver']
): string {
	if (resolver.configured === 'system') return `${PREFIX}.resolver.system`;
	return resolver.lastPath === 'system'
		? `${PREFIX}.resolver.fallback`
		: `${PREFIX}.resolver.bundled`;
}

/** Why a key was not saved, worded for the field under it. */
export function keyRejectionMessage(reason: KeyRejection): string {
	return `${PREFIX}.errors.${reason}`;
}

/**
 * The explanation shown under a failed check: the same reason sentences as the
 * Outbound IPs card, so the two surfaces never describe one failure twice.
 */
export function blocklistFailureDetail(spamhaus: SpamhausState): string | null {
	if (spamhaus.status !== 'unknown') return null;
	return `shared.outboundIpStatus.blocklist.unavailableReason.${spamhaus.reason ?? 'resolver_unreachable'}`;
}
