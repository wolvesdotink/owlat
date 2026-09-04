/** Tenant-owned send classes governed by the shared last-mile policy. */
export const GOVERNED_MESSAGE_TYPES = ['campaign', 'transactional', 'automation'] as const;

export type GovernedMessageType = (typeof GOVERNED_MESSAGE_TYPES)[number];
export type GovernedCandidateProvider = 'mta' | 'relay';
export type GovernedIpPool = 'campaign' | 'transactional';

/**
 * Authenticated delivery provenance. Member previews use the real transport
 * but must never mutate production recipient/reputation/compliance state.
 */
const DELIVERY_DOMAINS = ['production', 'member_test'] as const;
export type DeliveryDomain = (typeof DELIVERY_DOMAINS)[number];

/**
 * Exact context bound into an MTA routing lease. Keep this tuple shared by
 * Convex and the MTA so adding a routing input cannot silently create a replay
 * surface at the transport boundary.
 */
export interface GovernedRoutingContext {
	messageId: string;
	/** Unique queue/work identity. Never used as the provider or VERP id. */
	workAttemptId: string;
	/** Opaque Convex-issued handle to the server-side re-entry snapshot. */
	routingReentryToken: string;
	/** Original governed-delivery clock; every re-entry shares this deadline. */
	startedAt: number;
	deliveryDomain: DeliveryDomain;
	messageType: GovernedMessageType;
	organizationId: string;
	recipient: string;
	from: string;
	candidateProvider: GovernedCandidateProvider;
	ipPool: GovernedIpPool;
	allowWarmupOverflow: boolean;
}

export const ROUTING_LEASE_TOKEN_MAX_LENGTH = 128;

/**
 * The 409 code the governed `/send` intake answers when it could not READ the
 * lease record at all — a truncated or corrupt value, not a lease that aged out
 * or stopped binding (those keep `ROUTING_DECISION_EXPIRED`).
 *
 * SHARED BECAUSE THE TWO SIDES MUST AGREE LETTER FOR LETTER AND THE FAILURE IS
 * SILENT: the MTA writes this string on the wire (`apps/mta/src/routes/
 * sendRoutingLease.ts`) and Convex matches it (`lib/sendProviders/mta/index.ts`,
 * `categorizeError`) to answer `deferralOrigin: 'local'`. A typo on either side
 * does not throw — the answer simply falls back into the `governed` bucket this
 * code exists to keep it out of, and a lease-store fault starts spending gate
 * 2's 10%-ceiling/25%-halt budget again (issue #505).
 */
export const ROUTING_LEASE_UNREADABLE_CODE = 'ROUTING_LEASE_UNREADABLE';

export function isGovernedMessageType(value: unknown): value is GovernedMessageType {
	return GOVERNED_MESSAGE_TYPES.includes(value as GovernedMessageType);
}

export function isDeliveryDomain(value: unknown): value is DeliveryDomain {
	return DELIVERY_DOMAINS.includes(value as DeliveryDomain);
}
