import type { Context } from "hono";
import type Redis from "ioredis";
import { extractDomainOrNull, isValidEmail } from "@owlat/shared";
import type { MtaConfig } from "../config.js";
import type { AuthContext } from "../server.js";
import { canSend, reserveHalfOpenProbe } from "../intelligence/circuitBreaker.js";
import { reserveWarmingSlot, type WarmingReservation } from "../intelligence/warming.js";
import { resolveDestinationSnapshot } from "../smtp/destinationProvider.js";
import { resolvePool } from "../scaling/poolRules.js";
import { selectIpWithLease } from "../scaling/ipPool.js";
import type { DestinationProviderKey, IpPoolType } from "../types.js";

const ROUTING_LEASE_TTL_SECONDS = 15 * 60;
const ROUTING_LEASE_PREFIX = "mta:routing-lease:";

interface DecisionRequest {
	messageId: string;
	organizationId: string;
	recipient: string;
	from: string;
	candidateProvider: "mta" | "relay";
	ipPool: IpPoolType;
	allowWarmupOverflow: boolean;
}

export interface RoutingLeaseRecord {
	token: string;
	messageId: string;
	organizationId: string;
	recipient: string;
	destinationProvider: DestinationProviderKey;
	probe: boolean;
	expiresAt: number;
	ip?: string;
	eligibilityGeneration?: number;
	warmingReservation?: WarmingReservation;
}

export function isRoutingLeaseBoundTo(
	lease: RoutingLeaseRecord | null,
	request: { messageId: string; organizationId: string; recipient: string },
	now = Date.now(),
): lease is RoutingLeaseRecord {
	return Boolean(
		lease &&
		lease.expiresAt >= now &&
		lease.messageId === request.messageId &&
		lease.organizationId === request.organizationId &&
		lease.recipient === request.recipient.toLowerCase(),
	);
}

function authorizedForOrg(c: Context, organizationId: string): boolean {
	const auth = c.get("auth") as AuthContext;
	return auth.isMasterKey || auth.orgCredential?.organizationId === organizationId;
}

function validRequest(value: unknown): value is DecisionRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	const exact = [
		"messageId",
		"organizationId",
		"recipient",
		"from",
		"candidateProvider",
		"ipPool",
		"allowWarmupOverflow",
	];
	return (
		Object.keys(body).length === exact.length &&
		exact.every((key) => key in body) &&
		typeof body["messageId"] === "string" &&
		body["messageId"].length > 0 &&
		body["messageId"].length <= 256 &&
		typeof body["organizationId"] === "string" &&
		body["organizationId"].length > 0 &&
		body["organizationId"].length <= 128 &&
		typeof body["recipient"] === "string" &&
		isValidEmail(body["recipient"]) &&
		typeof body["from"] === "string" &&
		extractDomainOrNull(body["from"]) !== null &&
		(body["candidateProvider"] === "mta" || body["candidateProvider"] === "relay") &&
		(body["ipPool"] === "campaign" || body["ipPool"] === "transactional") &&
		typeof body["allowWarmupOverflow"] === "boolean"
	);
}

async function writeLease(redis: Redis, lease: RoutingLeaseRecord): Promise<void> {
	await redis.set(
		`${ROUTING_LEASE_PREFIX}${lease.token}`,
		JSON.stringify(lease),
		"EX",
		ROUTING_LEASE_TTL_SECONDS,
		"NX",
	);
}

export async function readRoutingLease(
	redis: Redis,
	token: string,
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
			return c.json({ error: "Invalid routing decision request" }, 400);
		}
		if (!validRequest(input)) return c.json({ error: "Invalid routing decision request" }, 400);
		if (!authorizedForOrg(c, input.organizationId))
			return c.json({ error: "Credential not authorized for this organization" }, 403);

		const global = await canSend(redis, input.organizationId);
		if (!global.allowed) {
			return c.json({
				decision: "defer",
				reason: "global_safety",
				retryAfterMs: global.retryAfter ?? 60_000,
			});
		}
		if (input.candidateProvider === "relay") return c.json({ decision: "relay" });

		const toDomain = extractDomainOrNull(input.recipient)!;
		const destination = await resolveDestinationSnapshot(redis, toDomain, { config });
		const provider = await canSend(redis, input.organizationId, destination.providerKey);
		let probe = false;
		if (!provider.allowed) return c.json({ decision: "relay", reason: "provider_breaker" });
		if (provider.state === "half-open") {
			probe = await reserveHalfOpenProbe(
				redis,
				input.organizationId,
				destination.providerKey,
				input.messageId,
			);
			if (!probe) return c.json({ decision: "relay", reason: "provider_probe_limit" });
		}

		const fromDomain = extractDomainOrNull(input.from) ?? undefined;
		const poolRule = await resolvePool(
			redis,
			input.organizationId,
			input.ipPool,
			fromDomain,
			toDomain,
		);
		const selected = await selectIpWithLease(
			redis,
			poolRule.pool,
			config.ipPools,
			poolRule.dedicatedIp,
		);
		if (!selected)
			return c.json({ decision: "defer", reason: "no_owned_ip", retryAfterMs: 60_000 });

		let warmingReservation: WarmingReservation | undefined;
		if (input.allowWarmupOverflow) {
			const reserved = await reserveWarmingSlot(redis, selected.ip, input.messageId);
			if (!reserved.allowed) return c.json({ decision: "relay", reason: "warmup_overflow" });
			warmingReservation = reserved.reservation;
		}

		const token = crypto.randomUUID();
		const lease: RoutingLeaseRecord = {
			token,
			messageId: input.messageId,
			organizationId: input.organizationId,
			recipient: input.recipient.toLowerCase(),
			destinationProvider: destination.providerKey,
			probe,
			expiresAt: Date.now() + ROUTING_LEASE_TTL_SECONDS * 1000,
			ip: selected.ip,
			eligibilityGeneration: selected.eligibilityGeneration,
			...(warmingReservation ? { warmingReservation } : {}),
		};
		await writeLease(redis, lease);
		return c.json({ decision: "mta", lease });
	};
}
