/**
 * POST /send — Queue a single email for delivery
 */

import type { Context } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { AuthContext } from '../server.js';
import {
	GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	isDeliveryDomain,
	isGovernedMessageType,
	isValidEmail,
	parseAddress,
	ROUTING_REENTRY_TOKEN_MAX_LENGTH,
} from '@owlat/shared';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { mapToPriority, priorityToOrderMs } from '../intelligence/engagementPriority.js';
import { checkSystemHealth } from '../scaling/degradation.js';
import { logger } from '../monitoring/logger.js';
import { isRoutingLeaseBoundTo, readRoutingLease } from './routingDecision.js';
import { canSend, canSendScope } from '../intelligence/circuitBreaker.js';
import { isIpEligibilityLeaseValid } from '../scaling/ipPool.js';
import {
	INTAKE_RESERVATION_LEASE_MS,
	hasAcceptedIntakeReceipt,
	intakeReceiptKey,
	parseIntakeReceipt,
} from './sendReceipt.js';

export { createSendReceiptHandler } from './sendReceipt.js';

/** Match the existing attachment-scan ceiling and bound Redis job growth. */
const MAX_SEALED_MIME_BYTES = 25 * 1024 * 1024;

interface SendRequest {
	messageId: string;
	workAttemptId?: string;
	routingReentryToken?: string;
	routingReentry?: EmailJob['routingReentry'];
	to: string;
	from: string;
	subject: string;
	html: string;
	text?: string;
	/** Postbox-only complete PGP/MIME bytes, base64-encoded. */
	sealedMimeBase64?: string;
	/** AMP4Email body — delivered as a `text/x-amp-html` alternative part. */
	amp?: string;
	replyTo?: string;
	headers?: Record<string, string>;
	ipPool: 'transactional' | 'campaign';
	organizationId: string;
	messageType?: 'campaign' | 'transactional' | 'automation';
	deliveryDomain?: import('@owlat/shared').DeliveryDomain;
	engagementScore?: number;
	dkimDomain: string;
	/**
	 * Postbox-only: the allowed-from set for the originating mailbox.
	 * Convex computes this at dispatch time (`resolveAllowedFromAddresses`)
	 * and passes it in so the MTA can refuse forged-From requests without
	 * a Convex round-trip. Lowercase canonical addresses.
	 *
	 * Shared-inbox send-as (a teammate replying under their own personal
	 * identity) is covered automatically: Convex keys this set on the SENDING
	 * mailbox, so the sanctioned cross-mailbox identity is already present here
	 * and every other address stays blocked. No MTA-side special-casing needed.
	 */
	allowedFromAddresses?: string[];
	/** Opaque lease token returned by POST /send/decision. */
	routingLease?: string;
	allowWarmupOverflow?: boolean;
}

/**
 * Create the send route handler
 */
export function createSendHandler(
	queue: Queue<EmailJob>,
	redis: Redis,
	mode: 'governed' | 'postbox' | 'system' = 'governed'
) {
	return async (c: Context) => {
		// Check system health
		const health = await checkSystemHealth(redis);
		if (!health.redisHealthy) {
			return c.json({ error: 'Service temporarily unavailable' }, 503);
		}
		if (health.backpressure) {
			return c.json({ error: 'Queue backpressure — try again later' }, 429);
		}

		// Parse and validate request
		let body: SendRequest;
		try {
			body = await c.req.json<SendRequest>();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		if (!body.messageId || !body.to || !body.from || !body.subject || !body.html) {
			return c.json({ error: 'Missing required fields: messageId, to, from, subject, html' }, 400);
		}

		// Validate email format (reject malformed addresses early)
		if (!isValidEmail(body.to)) {
			return c.json({ error: 'Invalid "to" email address format' }, 400);
		}
		// `from` may be a display-name form ("Owlat <noreply@mail.example.com>")
		// — composers build it via formatFromAddress with defaultFromName, so the
		// happy path is almost never a bare address. Hard-stop CR/LF first so a
		// crafted display name can't smuggle extra header lines (RFC 5322 §3.4
		// header injection), then validate the angle-addr the same way
		// extractDomainFromEmail does (parseAddress unwraps `Name <addr>`).
		if (/[\r\n]/.test(body.from)) {
			return c.json({ error: 'Invalid "from" email address format' }, 400);
		}
		const parsedFrom = parseAddress(body.from);
		if (!parsedFrom || !isValidEmail(parsedFrom.address)) {
			return c.json({ error: 'Invalid "from" email address format' }, 400);
		}
		if (body.replyTo && !isValidEmail(body.replyTo)) {
			return c.json({ error: 'Invalid "replyTo" email address format' }, 400);
		}

		if (!body.organizationId) {
			return c.json({ error: 'Missing required field: organizationId' }, 400);
		}

		// Enforce org scoping for per-org credentials
		const auth = c.get('auth') as AuthContext;
		if (mode === 'postbox') {
			if (!auth.isMasterKey || body.organizationId !== 'postbox') {
				return c.json({ error: 'Postbox intake requires the master credential' }, 403);
			}
			if (
				body.routingLease ||
				body.routingReentryToken ||
				body.routingReentry ||
				body.workAttemptId
			) {
				return c.json({ error: 'Postbox intake does not accept tenant routing leases' }, 400);
			}
		} else if (mode === 'system') {
			if (!auth.isMasterKey || body.organizationId !== 'system') {
				return c.json({ error: 'System intake requires the master credential' }, 403);
			}
			if (
				body.routingLease ||
				body.routingReentryToken ||
				body.routingReentry ||
				body.workAttemptId
			) {
				return c.json({ error: 'System intake does not accept tenant routing leases' }, 400);
			}
		} else {
			if (body.organizationId === 'postbox') {
				return c.json({ error: 'Postbox mail must use /send/postbox' }, 400);
			}
			if (!isGovernedMessageType(body.messageType)) {
				return c.json({ error: 'Missing or invalid governed messageType' }, 400);
			}
			if (!isDeliveryDomain(body.deliveryDomain)) {
				return c.json({ error: 'Missing or invalid governed deliveryDomain' }, 400);
			}
			if (!body.routingLease) {
				return c.json(
					{ error: 'A current routing lease is required', code: 'ROUTING_LEASE_REQUIRED' },
					409
				);
			}
			if (
				typeof body.routingReentryToken !== 'string' ||
				body.routingReentryToken.length < 1 ||
				body.routingReentryToken.length > ROUTING_REENTRY_TOKEN_MAX_LENGTH ||
				typeof body.workAttemptId !== 'string' ||
				body.workAttemptId.length < 1 ||
				body.workAttemptId.length > 128 ||
				!body.routingReentry ||
				typeof body.routingReentry.envelopeInput !== 'object' ||
				body.routingReentry.envelopeInput === null ||
				!body.routingReentry.retryState ||
				!Number.isInteger(body.routingReentry.retryState.attempt) ||
				body.routingReentry.retryState.attempt < 1 ||
				body.routingReentry.retryState.attempt > 9 ||
				!Number.isFinite(body.routingReentry.retryState.startedAt) ||
				body.routingReentry.retryState.startedAt > Date.now() ||
				Date.now() - body.routingReentry.retryState.startedAt >= GOVERNED_MTA_MAX_MESSAGE_AGE_MS ||
				body.routingReentry.retryState.idempotencyKey !== body.messageId
			) {
				return c.json({ error: 'Missing or invalid routing re-entry context' }, 400);
			}
		}
		if (!auth.isMasterKey && auth.orgCredential) {
			if (body.organizationId !== auth.orgCredential.organizationId) {
				return c.json({ error: 'Credential not authorized for this organization' }, 403);
			}
		}

		// Postbox path: Convex passes the mailbox's allowed-from set with
		// every dispatched message. The primary From-binding check runs
		// upstream in the draft→sent lifecycle reducer
		// (apps/api/convex/mail/draftLifecycle.ts, via
		// resolveAllowedFromAddressesForCtx) before any row is written;
		// re-validating here is the mandatory last-line forgery hard-stop
		// in case the upstream is bypassed or compromised. This is the only
		// place the MTA itself enforces From ownership, so ANY new
		// send-intake route MUST run this same check. (The unused
		// /send/batch route was removed precisely because it duplicated this
		// intake without the gate — don't reintroduce a gateless bulk path.)
		if (mode === 'postbox') {
			// Compare the angle-addr, not the raw header: a display-name From
			// ("Alice <alice@example.com>") must still bind to the bare allowed
			// address, while a forged address can't hide behind a display name.
			const fromLower = parsedFrom.address;
			const ok = body.allowedFromAddresses?.some((allowed) => allowed.toLowerCase() === fromLower);
			if (!ok) {
				logger.warn(
					{ messageId: body.messageId, from: body.from, allowed: body.allowedFromAddresses },
					'Postbox /send rejected — From address not in allowed set'
				);
				return c.json({ error: 'From address not authorized for this mailbox' }, 403);
			}
		}

		if (!body.dkimDomain) {
			return c.json({ error: 'Missing required field: dkimDomain' }, 400);
		}

		let routingLease: EmailJob['routingLease'];
		if (mode === 'governed' && body.routingLease) {
			const lease = await readRoutingLease(redis, body.routingLease);
			if (
				!isRoutingLeaseBoundTo(lease, {
					messageId: body.messageId,
					workAttemptId: body.workAttemptId!,
					routingReentryToken: body.routingReentryToken!,
					startedAt: body.routingReentry!.retryState.startedAt,
					deliveryDomain: body.deliveryDomain!,
					organizationId: body.organizationId,
					recipient: body.to,
					from: body.from,
					messageType: body.messageType!,
					candidateProvider: 'mta',
					ipPool: body.ipPool,
					allowWarmupOverflow: body.allowWarmupOverflow === true,
				})
			) {
				return c.json(
					{ error: 'Routing decision expired; resolve again', code: 'ROUTING_DECISION_EXPIRED' },
					409
				);
			}
			const global = await canSend(redis, body.organizationId);
			if (!global.allowed || global.generation !== lease.globalBreakerGeneration) {
				return c.json(
					{ error: 'Delivery temporarily deferred by safety policy', code: 'GLOBAL_SAFETY_DEFER' },
					409
				);
			}
			const provider = await canSendScope(redis, body.organizationId, lease.destinationProvider);
			if (!provider.allowed || provider.generation !== lease.providerBreakerGeneration) {
				return c.json(
					{
						error: 'Destination provider route changed; resolve again',
						code: 'ROUTING_DECISION_CHANGED',
					},
					409
				);
			}
			if (
				lease.ip &&
				lease.eligibilityGeneration !== undefined &&
				!(await isIpEligibilityLeaseValid(redis, {
					ip: lease.ip,
					eligibilityGeneration: lease.eligibilityGeneration,
				}))
			) {
				return c.json(
					{
						error: 'Owned IP eligibility changed; resolve again',
						code: 'ROUTING_DECISION_CHANGED',
					},
					409
				);
			}
			routingLease = {
				token: lease.token,
				destinationProvider: lease.destinationProvider,
				probe: lease.probe,
				globalProbe: lease.globalProbe,
				ip: lease.ip,
				eligibilityGeneration: lease.eligibilityGeneration,
				globalBreakerGeneration: lease.globalBreakerGeneration,
				providerBreakerGeneration: lease.providerBreakerGeneration,
				warmingReservation: lease.warmingReservation,
			};
		}

		if (body.sealedMimeBase64) {
			if (body.organizationId !== 'postbox') {
				return c.json({ error: 'sealedMimeBase64 is restricted to Postbox mail' }, 400);
			}
			if (
				!/^[A-Za-z0-9+/]+={0,2}$/.test(body.sealedMimeBase64) ||
				body.sealedMimeBase64.length % 4 !== 0
			) {
				return c.json({ error: 'sealedMimeBase64 must be valid base64' }, 400);
			}
			const rawBytes = Buffer.from(body.sealedMimeBase64, 'base64');
			if (rawBytes.length > MAX_SEALED_MIME_BYTES) {
				return c.json({ error: 'sealedMimeBase64 exceeds the 25 MiB limit' }, 400);
			}
			const raw = rawBytes.toString('utf8');
			const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0]?.replace(/\r?\n[ \t]+/g, ' ') ?? '';
			const header = (name: string) =>
				headerBlock.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'im'))?.[1]?.trim();
			const rawFrom = parseAddress(header('From') ?? '');
			const contentType = header('Content-Type') ?? '';
			if (
				rawFrom?.address !== parsedFrom.address ||
				header('Subject') !== '...' ||
				!/^multipart\/encrypted\b/i.test(contentType) ||
				!/[;\s]protocol="?application\/pgp-encrypted"?/i.test(contentType)
			) {
				return c.json({ error: 'sealedMimeBase64 is not an authorized PGP/MIME message' }, 400);
			}
		}

		if (body.ipPool !== 'transactional' && body.ipPool !== 'campaign') {
			return c.json({ error: 'ipPool must be "transactional" or "campaign"' }, 400);
		}

		// Provider/VERP identity is stable, but each bounded routing attempt must
		// create real work. Deduplicate only the lease-bound attempt identity.
		const queueIdentity = mode === 'governed' ? body.workAttemptId! : body.messageId;
		const dedupKey = intakeReceiptKey(queueIdentity);
		const reservationNow = Date.now();
		const reservedReceipt = JSON.stringify({
			state: 'reserved',
			messageId: body.messageId,
			reservedAt: reservationNow,
		});
		const acceptedReceipt = JSON.stringify({
			state: 'accepted',
			messageId: body.messageId,
			acceptedAt: reservationNow,
		});
		const wasNew = await redis.set(
			dedupKey,
			reservedReceipt,
			'PX',
			GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
			'NX'
		);
		let ownsReservation = wasNew === 'OK';
		if (!ownsReservation) {
			const rawExisting = await redis.get(dedupKey);
			const existing = parseIntakeReceipt(rawExisting);
			if (existing?.state === 'accepted' && existing.messageId === body.messageId) {
				logger.info(
					{ messageId: body.messageId, workAttemptId: queueIdentity },
					'Duplicate work attempt — skipping'
				);
				return c.json({ success: true, id: body.messageId, deduplicated: true });
			}
			const queued = typeof queue.getJob === 'function' ? await queue.getJob(queueIdentity) : null;
			if (queued && (!existing || existing.messageId === body.messageId)) {
				await redis.set(dedupKey, acceptedReceipt, 'PX', GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
			}
			const receipt = parseIntakeReceipt(await redis.get(dedupKey));
			if (receipt?.state === 'accepted' && receipt.messageId === body.messageId) {
				logger.info(
					{ messageId: body.messageId, workAttemptId: queueIdentity },
					'Duplicate work attempt — skipping'
				);
				return c.json({ success: true, id: body.messageId, deduplicated: true });
			}
			const stale =
				!existing ||
				(existing.state === 'reserved' &&
					existing.messageId === body.messageId &&
					existing.reservedAt + INTAKE_RESERVATION_LEASE_MS <= reservationNow);
			if (stale) {
				ownsReservation = rawExisting
					? ((await redis.eval(
							"if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 end return 0",
							1,
							dedupKey,
							rawExisting,
							reservedReceipt,
							String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)
						)) as number) === 1
					: (await redis.set(
							dedupKey,
							reservedReceipt,
							'PX',
							GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
							'NX'
						)) === 'OK';
			}
			if (!ownsReservation) {
				return c.json(
					{
						error: 'Intake reservation is still pending',
						code: 'INTAKE_PENDING',
						retryAfterMs: 1_000,
					},
					409
				);
			}
		}

		// Build job
		const job: EmailJob = {
			messageId: body.messageId,
			workAttemptId: body.workAttemptId,
			to: body.to,
			from: body.from,
			subject: body.subject,
			html: body.html,
			text: body.text,
			sealedMimeBase64: body.sealedMimeBase64,
			amp: body.amp,
			replyTo: body.replyTo,
			headers: body.headers,
			ipPool: body.ipPool,
			organizationId: body.organizationId,
			deliveryDomain: mode === 'governed' ? body.deliveryDomain : undefined,
			engagementScore: body.engagementScore,
			dkimDomain: body.dkimDomain,
			firstEnqueuedAt: mode === 'governed' ? body.routingReentry!.retryState.startedAt : Date.now(),
			...(routingLease ? { routingLease } : {}),
			...(mode === 'governed' && body.routingReentryToken
				? { routingReentryToken: body.routingReentryToken }
				: {}),
			...(mode === 'governed' && body.routingReentry
				? { routingReentry: body.routingReentry }
				: {}),
		};

		// Calculate group key and priority
		const domain = extractDomain(body.to);
		const groupId = buildGroupKey(body.ipPool, domain);
		const priority = mapToPriority(body.engagementScore);

		try {
			// GroupMQ identity is attempt-scoped. `job.data.messageId` remains the
			// stable provider/VERP correlation id used by lifecycle webhooks.
			const result = await queue.add({
				groupId,
				data: job,
				orderMs: priorityToOrderMs(priority),
				jobId: queueIdentity,
			});
			// This write is the durable receipt boundary. If the HTTP response is
			// lost, Convex can prove acceptance without starting a fresh route.
			await redis.set(dedupKey, acceptedReceipt, 'PX', GOVERNED_MTA_MAX_MESSAGE_AGE_MS);

			logger.debug(
				{ messageId: body.messageId, groupId, priority, jobId: result.id },
				'Email queued'
			);

			return c.json({ success: true, id: body.messageId, workAttemptId: result.id });
		} catch (err) {
			// queue.add may have committed before its client observed an error. The
			// deterministic job id is authoritative in that ambiguity window.
			const queued = await queue.getJob(queueIdentity).catch(() => null);
			if (queued) {
				await redis.set(dedupKey, acceptedReceipt, 'PX', GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
				return c.json({ success: true, id: body.messageId, workAttemptId: queueIdentity });
			}
			// A fast worker may have completed and been trimmed before queue.add's
			// client observed its response. Its receipt promotion is authoritative.
			if (await hasAcceptedIntakeReceipt(redis, dedupKey, body.messageId)) {
				return c.json({ success: true, id: body.messageId, workAttemptId: queueIdentity });
			}
			await redis.eval(
				"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
				1,
				dedupKey,
				reservedReceipt
			);
			logger.error({ err, messageId: body.messageId }, 'Failed to enqueue email');
			return c.json({ error: 'Failed to queue email' }, 500);
		}
	};
}
