import type { Context } from 'hono';
import type Redis from 'ioredis';
import {
	extractDomainOrNull,
	isGovernedMessageType,
	isValidEmail,
	parseAddress,
	ROUTING_REENTRY_TOKEN_MAX_LENGTH,
	type GovernedRoutingContext,
} from '@owlat/shared';
import type { MtaConfig } from '../config.js';
import type { AuthContext } from '../server.js';
import {
	canSend,
	canSendScope,
	isRelayAllowedByGlobalBreaker,
	releaseHalfOpenProbe,
	reserveHalfOpenProbe,
} from '../intelligence/circuitBreaker.js';
import {
	releaseWarmingSlot,
	reserveWarmingSlot,
	type WarmingReservation,
} from '../intelligence/warming.js';
import { resolveDestinationSnapshot } from '../smtp/destinationProvider.js';
import { resolvePool } from '../scaling/poolRules.js';
import { selectIpWithLease } from '../scaling/ipPool.js';
import type { DestinationProviderKey, IpPoolType } from '../types.js';

const ROUTING_LEASE_TTL_SECONDS = 15 * 60;
const ROUTING_LEASE_PREFIX = 'mta:routing-lease:';

type DecisionRequest = GovernedRoutingContext;

export interface RoutingLeaseRecord {
	token: string;
	messageId: string;
	workAttemptId: string;
	routingReentryToken: string;
	organizationId: string;
	recipient: string;
	from: string;
	messageType: DecisionRequest['messageType'];
	candidateProvider: DecisionRequest['candidateProvider'];
	ipPool: IpPoolType;
	allowWarmupOverflow: boolean;
	destinationProvider: DestinationProviderKey;
	probe: boolean;
	globalProbe: boolean;
	expiresAt: number;
	ip?: string;
	eligibilityGeneration?: number;
	globalBreakerGeneration: number;
	providerBreakerGeneration?: number;
	warmingReservation?: WarmingReservation;
}

export function isRoutingLeaseBoundTo(
	lease: RoutingLeaseRecord | null,
	request: DecisionRequest,
	now = Date.now()
): lease is RoutingLeaseRecord {
	return Boolean(
		lease &&
		lease.expiresAt >= now &&
		lease.messageId === request.messageId &&
		lease.workAttemptId === request.workAttemptId &&
		lease.routingReentryToken === request.routingReentryToken &&
		lease.organizationId === request.organizationId &&
		lease.recipient === request.recipient.toLowerCase() &&
		lease.from === normalizedFrom(request.from) &&
		lease.messageType === request.messageType &&
		lease.candidateProvider === request.candidateProvider &&
		lease.ipPool === request.ipPool &&
		lease.allowWarmupOverflow === request.allowWarmupOverflow
	);
}

function normalizedFrom(value: string): string {
	return parseAddress(value)?.address ?? '';
}

function authorizedForOrg(c: Context, organizationId: string): boolean {
	const auth = c.get('auth') as AuthContext;
	return auth.isMasterKey || auth.orgCredential?.organizationId === organizationId;
}

function validRequest(value: unknown): value is DecisionRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	const exact = [
		'messageId',
		'workAttemptId',
		'routingReentryToken',
		'messageType',
		'organizationId',
		'recipient',
		'from',
		'candidateProvider',
		'ipPool',
		'allowWarmupOverflow',
	];
	return (
		Object.keys(body).length === exact.length &&
		exact.every((key) => key in body) &&
		typeof body['messageId'] === 'string' &&
		body['messageId'].length > 0 &&
		body['messageId'].length <= 256 &&
		typeof body['workAttemptId'] === 'string' &&
		body['workAttemptId'].length > 0 &&
		body['workAttemptId'].length <= 128 &&
		typeof body['routingReentryToken'] === 'string' &&
		body['routingReentryToken'].length > 0 &&
		body['routingReentryToken'].length <= ROUTING_REENTRY_TOKEN_MAX_LENGTH &&
		isGovernedMessageType(body['messageType']) &&
		typeof body['organizationId'] === 'string' &&
		body['organizationId'].length > 0 &&
		body['organizationId'].length <= 128 &&
		typeof body['recipient'] === 'string' &&
		isValidEmail(body['recipient']) &&
		typeof body['from'] === 'string' &&
		normalizedFrom(body['from']).length > 0 &&
		(body['candidateProvider'] === 'mta' || body['candidateProvider'] === 'relay') &&
		(body['ipPool'] === 'campaign' || body['ipPool'] === 'transactional') &&
		typeof body['allowWarmupOverflow'] === 'boolean'
	);
}

async function writeLease(redis: Redis, lease: RoutingLeaseRecord): Promise<void> {
	const stored = await redis.set(
		`${ROUTING_LEASE_PREFIX}${lease.token}`,
		JSON.stringify(lease),
		'EX',
		ROUTING_LEASE_TTL_SECONDS,
		'NX'
	);
	if (stored !== 'OK') throw new Error('Routing lease token collision');
}

export async function readRoutingLease(
	redis: Redis,
	token: string
): Promise<RoutingLeaseRecord | null> {
	const raw = await redis.get(`${ROUTING_LEASE_PREFIX}${token}`);
	if (!raw) return null;
	try {
		const lease = JSON.parse(raw) as RoutingLeaseRecord;
		return lease.token === token && lease.expiresAt >= Date.now() ? lease : null;
	} catch {
		return null;
	}
}

export function createRoutingDecisionHandler(redis: Redis, config: MtaConfig) {
	return async (c: Context) => {
		let input: unknown;
		try {
			input = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid routing decision request' }, 400);
		}
		if (!validRequest(input)) return c.json({ error: 'Invalid routing decision request' }, 400);
		if (!authorizedForOrg(c, input.organizationId))
			return c.json({ error: 'Credential not authorized for this organization' }, 403);

		const global = await canSend(redis, input.organizationId);
		if (!global.allowed) {
			return c.json({
				decision: 'defer',
				reason: 'global_safety',
				retryAfterMs: global.retryAfter ?? 60_000,
			});
		}
		if (input.candidateProvider === 'relay') {
			return (await isRelayAllowedByGlobalBreaker(redis, input.organizationId))
				? c.json({ decision: 'relay' })
				: c.json({ decision: 'defer', reason: 'global_safety', retryAfterMs: 60_000 });
		}

		const toDomain = extractDomainOrNull(input.recipient)!;
		const destination = await resolveDestinationSnapshot(redis, toDomain, { config });
		const provider = await canSendScope(redis, input.organizationId, destination.providerKey);
		if (!provider.allowed) {
			return (await isRelayAllowedByGlobalBreaker(redis, input.organizationId))
				? c.json({ decision: 'relay', reason: 'provider_breaker' })
				: c.json({ decision: 'defer', reason: 'global_safety', retryAfterMs: 60_000 });
		}
		// Re-read global after the provider check. A global breaker transition must
		// dominate every provider-local fallback decision, including one racing
		// this request; it is never safe to translate that transition into relay.
		const currentGlobal = await canSend(redis, input.organizationId);
		if (!currentGlobal.allowed) {
			return c.json({
				decision: 'defer',
				reason: 'global_safety',
				retryAfterMs: currentGlobal.retryAfter ?? 60_000,
			});
		}
		if (currentGlobal.state === 'half-open' && global.state !== 'half-open') {
			return c.json({ decision: 'defer', reason: 'global_probe', retryAfterMs: 60_000 });
		}

		const fromDomain = extractDomainOrNull(input.from) ?? undefined;
		const poolRule = await resolvePool(
			redis,
			input.organizationId,
			input.ipPool,
			fromDomain,
			toDomain
		);
		const selected = await selectIpWithLease(
			redis,
			poolRule.pool,
			config.ipPools,
			poolRule.dedicatedIp
		);
		if (!selected)
			return c.json({ decision: 'defer', reason: 'no_owned_ip', retryAfterMs: 60_000 });

		let warmingReservation: WarmingReservation | undefined;
		if (input.allowWarmupOverflow) {
			const reserved = await reserveWarmingSlot(redis, selected.ip, input.messageId);
			if (!reserved.allowed) {
				return (await isRelayAllowedByGlobalBreaker(redis, input.organizationId))
					? c.json({ decision: 'relay', reason: 'warmup_overflow' })
					: c.json({ decision: 'defer', reason: 'global_safety', retryAfterMs: 60_000 });
			}
			warmingReservation = reserved.reservation;
		}

		let globalProbe = false;
		let providerProbe = false;
		let leaseToken: string | undefined;
		try {
			if (currentGlobal.state === 'half-open') {
				globalProbe = await reserveHalfOpenProbe(
					redis,
					input.organizationId,
					undefined,
					input.messageId,
					Date.now(),
					currentGlobal.generation
				);
				if (!globalProbe) {
					if (warmingReservation) await releaseWarmingSlot(redis, warmingReservation);
					return c.json({ decision: 'defer', reason: 'global_probe', retryAfterMs: 60_000 });
				}
			}
			if (provider.state === 'half-open') {
				providerProbe = await reserveHalfOpenProbe(
					redis,
					input.organizationId,
					destination.providerKey,
					input.messageId,
					Date.now(),
					provider.generation
				);
				if (!providerProbe) {
					if (globalProbe)
						await releaseHalfOpenProbe(
							redis,
							input.organizationId,
							undefined,
							input.messageId,
							currentGlobal.generation
						);
					if (warmingReservation) await releaseWarmingSlot(redis, warmingReservation);
					return (await isRelayAllowedByGlobalBreaker(redis, input.organizationId))
						? c.json({ decision: 'relay', reason: 'provider_probe_limit' })
						: c.json({ decision: 'defer', reason: 'global_safety', retryAfterMs: 60_000 });
				}
			}

			leaseToken = crypto.randomUUID();
			const lease: RoutingLeaseRecord = {
				token: leaseToken,
				messageId: input.messageId,
				workAttemptId: input.workAttemptId,
				routingReentryToken: input.routingReentryToken,
				organizationId: input.organizationId,
				recipient: input.recipient.toLowerCase(),
				from: normalizedFrom(input.from),
				messageType: input.messageType,
				candidateProvider: input.candidateProvider,
				ipPool: input.ipPool,
				allowWarmupOverflow: input.allowWarmupOverflow,
				destinationProvider: destination.providerKey,
				probe: providerProbe,
				globalProbe,
				expiresAt: Date.now() + ROUTING_LEASE_TTL_SECONDS * 1000,
				ip: selected.ip,
				eligibilityGeneration: selected.eligibilityGeneration,
				globalBreakerGeneration: currentGlobal.generation,
				providerBreakerGeneration: provider.generation,
				...(warmingReservation ? { warmingReservation } : {}),
			};
			await writeLease(redis, lease);
			return c.json({ decision: 'mta', lease: { token: leaseToken } });
		} catch {
			if (leaseToken) await redis.del(`${ROUTING_LEASE_PREFIX}${leaseToken}`).catch(() => 0);
			if (providerProbe) {
				await releaseHalfOpenProbe(
					redis,
					input.organizationId,
					destination.providerKey,
					input.messageId,
					provider.generation
				).catch(() => {});
			}
			if (globalProbe) {
				await releaseHalfOpenProbe(
					redis,
					input.organizationId,
					undefined,
					input.messageId,
					currentGlobal.generation
				).catch(() => {});
			}
			if (warmingReservation) {
				await releaseWarmingSlot(redis, warmingReservation).catch(() => {});
			}
			return c.json({ decision: 'defer', reason: 'lease_persistence', retryAfterMs: 60_000 });
		}
	};
}
