/**
 * POST /send — Queue a single email for delivery
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { AuthContext } from '../server.js';
import type { MtaSendAccepted, MtaSendRefused, MtaSendRequest } from '@owlat/mta-protocol';
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

import { readEngagementScore } from './sendEngagementScore.js';

export { createSendReceiptHandler } from './sendReceipt.js';

/** Match the existing attachment-scan ceiling and bound Redis job growth. */
const MAX_SEALED_MIME_BYTES = 25 * 1024 * 1024;

/**
 * The two answers the intake may give, each bound to its one declaration (D7).
 *
 * Every `return` in the handler goes through one of these, for the same reason
 * `/send/decision`'s `decide()` exists: the request half of this wire was typed
 * against `MtaSendRequest` while the response half stayed bare object literals,
 * so a field renamed in `MtaSendAccepted` or a code dropped from
 * `MTA_SEND_ERROR_CODES` still compiled here and kept the old bytes flowing to a
 * Convex reader that had moved. Now it stops compiling on this side too.
 *
 * `c.json` walks the literal's own key order, so the bytes are unchanged.
 */
function accepted(c: Context, answer: MtaSendAccepted) {
	return c.json(answer);
}

function refuse(c: Context, answer: MtaSendRefused, status: ContentfulStatusCode) {
	return c.json(answer, status);
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
			return refuse(c, { error: 'Service temporarily unavailable' }, 503);
		}
		if (health.backpressure) {
			return refuse(c, { error: 'Queue backpressure — try again later' }, 429);
		}

		// Parse and validate request
		let body: MtaSendRequest;
		try {
			body = await c.req.json<MtaSendRequest>();
		} catch {
			return refuse(c, { error: 'Invalid JSON body' }, 400);
		}

		if (!body.messageId || !body.to || !body.from || !body.subject || !body.html) {
			return refuse(
				c,
				{ error: 'Missing required fields: messageId, to, from, subject, html' },
				400
			);
		}

		// Validate email format (reject malformed addresses early)
		if (!isValidEmail(body.to)) {
			return refuse(c, { error: 'Invalid "to" email address format' }, 400);
		}
		// `from` may be a display-name form ("Owlat <noreply@mail.example.com>")
		// — composers build it via formatFromAddress with defaultFromName, so the
		// happy path is almost never a bare address. Hard-stop CR/LF first so a
		// crafted display name can't smuggle extra header lines (RFC 5322 §3.4
		// header injection), then validate the angle-addr the same way
		// extractDomainFromEmail does (parseAddress unwraps `Name <addr>`).
		if (/[\r\n]/.test(body.from)) {
			return refuse(c, { error: 'Invalid "from" email address format' }, 400);
		}
		const parsedFrom = parseAddress(body.from);
		if (!parsedFrom || !isValidEmail(parsedFrom.address)) {
			return refuse(c, { error: 'Invalid "from" email address format' }, 400);
		}
		if (body.replyTo && !isValidEmail(body.replyTo)) {
			return refuse(c, { error: 'Invalid "replyTo" email address format' }, 400);
		}

		if (!body.organizationId) {
			return refuse(c, { error: 'Missing required field: organizationId' }, 400);
		}

		// Enforce org scoping for per-org credentials
		const auth = c.get('auth') as AuthContext;
		if (mode === 'postbox') {
			if (!auth.isMasterKey || body.organizationId !== 'postbox') {
				return refuse(c, { error: 'Postbox intake requires the master credential' }, 403);
			}
			if (
				body.routingLease ||
				body.routingReentryToken ||
				body.routingReentry ||
				body.workAttemptId
			) {
				return refuse(c, { error: 'Postbox intake does not accept tenant routing leases' }, 400);
			}
		} else if (mode === 'system') {
			if (!auth.isMasterKey || body.organizationId !== 'system') {
				return refuse(c, { error: 'System intake requires the master credential' }, 403);
			}
			if (
				body.routingLease ||
				body.routingReentryToken ||
				body.routingReentry ||
				body.workAttemptId
			) {
				return refuse(c, { error: 'System intake does not accept tenant routing leases' }, 400);
			}
		} else {
			if (body.organizationId === 'postbox') {
				return refuse(c, { error: 'Postbox mail must use /send/postbox' }, 400);
			}
			if (!isGovernedMessageType(body.messageType)) {
				return refuse(c, { error: 'Missing or invalid governed messageType' }, 400);
			}
			if (!isDeliveryDomain(body.deliveryDomain)) {
				return refuse(c, { error: 'Missing or invalid governed deliveryDomain' }, 400);
			}
			if (!body.routingLease) {
				return refuse(
					c,
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
				return refuse(c, { error: 'Missing or invalid routing re-entry context' }, 400);
			}
		}
		if (!auth.isMasterKey && auth.orgCredential) {
			if (body.organizationId !== auth.orgCredential.organizationId) {
				return refuse(c, { error: 'Credential not authorized for this organization' }, 403);
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
				return refuse(c, { error: 'From address not authorized for this mailbox' }, 403);
			}
		}

		if (!body.dkimDomain) {
			return refuse(c, { error: 'Missing required field: dkimDomain' }, 400);
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
				return refuse(
					c,
					{ error: 'Routing decision expired; resolve again', code: 'ROUTING_DECISION_EXPIRED' },
					409
				);
			}
			const global = await canSend(redis, body.organizationId);
			if (!global.allowed || global.generation !== lease.globalBreakerGeneration) {
				return refuse(
					c,
					{ error: 'Delivery temporarily deferred by safety policy', code: 'GLOBAL_SAFETY_DEFER' },
					409
				);
			}
			const provider = await canSendScope(redis, body.organizationId, lease.destinationProvider);
			if (!provider.allowed || provider.generation !== lease.providerBreakerGeneration) {
				return refuse(
					c,
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
				return refuse(
					c,
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
				return refuse(c, { error: 'sealedMimeBase64 is restricted to Postbox mail' }, 400);
			}
			if (
				!/^[A-Za-z0-9+/]+={0,2}$/.test(body.sealedMimeBase64) ||
				body.sealedMimeBase64.length % 4 !== 0
			) {
				return refuse(c, { error: 'sealedMimeBase64 must be valid base64' }, 400);
			}
			const rawBytes = Buffer.from(body.sealedMimeBase64, 'base64');
			if (rawBytes.length > MAX_SEALED_MIME_BYTES) {
				return refuse(c, { error: 'sealedMimeBase64 exceeds the 25 MiB limit' }, 400);
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
				return refuse(c, { error: 'sealedMimeBase64 is not an authorized PGP/MIME message' }, 400);
			}
		}

		if (body.ipPool !== 'transactional' && body.ipPool !== 'campaign') {
			return refuse(c, { error: 'ipPool must be "transactional" or "campaign"' }, 400);
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
				return accepted(c, { success: true, id: body.messageId, deduplicated: true });
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
				return accepted(c, { success: true, id: body.messageId, deduplicated: true });
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
				return refuse(
					c,
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
		const engagementScore = readEngagementScore(body.messageId, body.engagementScore);
		const job: EmailJob = {
			messageId: body.messageId,
			intakeReceiptId: queueIdentity,
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
			engagementScore,
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
		const priority = mapToPriority(engagementScore);

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

			return accepted(c, { success: true, id: body.messageId, workAttemptId: result.id });
		} catch (err) {
			// queue.add may have committed before its client observed an error. The
			// deterministic job id is authoritative in that ambiguity window.
			const queued = await queue.getJob(queueIdentity).catch(() => null);
			if (queued) {
				await redis.set(dedupKey, acceptedReceipt, 'PX', GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
				return accepted(c, { success: true, id: body.messageId, workAttemptId: queueIdentity });
			}
			// A fast worker may have completed and been trimmed before queue.add's
			// client observed its response. Its receipt promotion is authoritative.
			if (await hasAcceptedIntakeReceipt(redis, dedupKey, body.messageId)) {
				return accepted(c, { success: true, id: body.messageId, workAttemptId: queueIdentity });
			}
			await redis.eval(
				"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
				1,
				dedupKey,
				reservedReceipt
			);
			logger.error({ err, messageId: body.messageId }, 'Failed to enqueue email');
			return refuse(c, { error: 'Failed to queue email' }, 500);
		}
	};
}
