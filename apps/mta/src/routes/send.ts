/**
 * POST /send — Queue a single email for delivery
 */

import type { Context } from 'hono';
import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import type { EmailJob } from '../types.js';
import type { AuthContext } from '../server.js';
import { isValidEmail, parseAddress } from '@owlat/shared';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { mapToPriority } from '../intelligence/engagementPriority.js';

/**
 * Convert priority level (1-4) to an orderMs value.
 * Lower orderMs = processed first. Priority 1 gets timestamp 0,
 * priority 4 gets current timestamp. This ensures high-engagement
 * emails are always dequeued before low-engagement ones.
 */
function priorityToOrderMs(priority: number): number {
	// Use a far-past base timestamp so priority jobs always go first
	// Priority 1: 0ms, Priority 2: 1ms, Priority 3: 2ms, Priority 4: current time
	if (priority <= 3) return priority;
	return Date.now();
}
import { checkSystemHealth } from '../scaling/degradation.js';
import { logger } from '../monitoring/logger.js';

/** Match the existing attachment-scan ceiling and bound Redis job growth. */
const MAX_SEALED_MIME_BYTES = 25 * 1024 * 1024;

interface SendRequest {
	messageId: string;
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
}

/**
 * Create the send route handler
 */
export function createSendHandler(queue: Queue<EmailJob>, redis: Redis) {
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
		if (body.organizationId === 'postbox' && body.allowedFromAddresses) {
			// Compare the angle-addr, not the raw header: a display-name From
			// ("Alice <alice@example.com>") must still bind to the bare allowed
			// address, while a forged address can't hide behind a display name.
			const fromLower = parsedFrom.address;
			const ok = body.allowedFromAddresses.some((allowed) => allowed.toLowerCase() === fromLower);
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

		// Deduplication: prevent re-queuing the same messageId (e.g., from Convex retries)
		const dedupKey = `mta:sent-ids:${body.messageId}`;
		const wasNew = await redis.set(dedupKey, '1', 'EX', 86400, 'NX'); // TTL: 24h, set-if-not-exists
		if (!wasNew) {
			logger.info({ messageId: body.messageId }, 'Duplicate messageId — skipping');
			// Return the REAL messageId (the VERP token), not a literal "duplicate".
			// The caller (Convex worker) stores the returned `id` as
			// `providerMessageId`; the SMTP sender encodes that SAME `messageId` into
			// the VERP Return-Path. If we returned "duplicate" here, the stored
			// providerMessageId would never match the VERP token carried by the
			// already-enqueued message, so every later bounce/complaint webhook would
			// resolve to send_not_found and the hard-bouncing recipient would never be
			// suppressed. Echoing body.messageId keeps stored id == VERP token.
			return c.json({ success: true, id: body.messageId, deduplicated: true });
		}

		// Build job
		const job: EmailJob = {
			messageId: body.messageId,
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
			engagementScore: body.engagementScore,
			dkimDomain: body.dkimDomain,
			firstEnqueuedAt: Date.now(),
		};

		// Calculate group key and priority
		const domain = extractDomain(body.to);
		const groupId = buildGroupKey(body.ipPool, domain);
		const priority = mapToPriority(body.engagementScore);

		try {
			// jobId MUST equal body.messageId. The caller (Convex worker) stores
			// the returned `id` as `emailSends/transactionalSends.providerMessageId`,
			// and the SMTP sender encodes that SAME `messageId` into the VERP
			// Return-Path (apps/mta/src/smtp/sender.ts → buildVerpAddress). When an
			// async DSN bounces back, the VERP token is decoded and looked up via
			// `by_provider_message_id` (apps/api/convex/delivery/sendLifecycle.ts).
			// If we let groupmq mint a random UUID here, the stored
			// providerMessageId never matches the VERP token and every
			// post-acceptance bounce is silently dropped (send_not_found). Pinning
			// jobId = messageId keeps acceptance id == VERP token == stored
			// providerMessageId. (It also gives groupmq queue-level idempotency on
			// the same key the Redis SET-NX dedup already uses.)
			const result = await queue.add({
				groupId,
				data: job,
				orderMs: priorityToOrderMs(priority),
				jobId: body.messageId,
			});

			logger.debug(
				{ messageId: body.messageId, groupId, priority, jobId: result.id },
				'Email queued'
			);

			return c.json({ success: true, id: result.id });
		} catch (err) {
			logger.error({ err, messageId: body.messageId }, 'Failed to enqueue email');
			return c.json({ error: 'Failed to queue email' }, 500);
		}
	};
}
