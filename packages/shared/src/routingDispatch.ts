/** Tenant-owned send classes governed by the shared last-mile policy. */
export const GOVERNED_MESSAGE_TYPES = ['campaign', 'transactional', 'automation'] as const;

export type GovernedMessageType = (typeof GOVERNED_MESSAGE_TYPES)[number];
export type GovernedCandidateProvider = 'mta' | 'relay';
export type GovernedIpPool = 'campaign' | 'transactional';

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
	messageType: GovernedMessageType;
	organizationId: string;
	recipient: string;
	from: string;
	candidateProvider: GovernedCandidateProvider;
	ipPool: GovernedIpPool;
	allowWarmupOverflow: boolean;
}

export const ROUTING_LEASE_TOKEN_MAX_LENGTH = 128;

export function isGovernedMessageType(value: unknown): value is GovernedMessageType {
	return GOVERNED_MESSAGE_TYPES.includes(value as GovernedMessageType);
}
