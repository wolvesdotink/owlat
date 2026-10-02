/**
 * POST /scan/attachment — Scan an attachment for malware and dangerous file types
 * POST /scan/content    — Preview the content-screening verdict for a draft
 *
 * This endpoint combines:
 * 1. File type validation (magic bytes + extension check)
 * 2. ClamAV malware scanning (if ClamAV sidecar is available)
 *
 * Used by emailWorker.ts (Convex action) to validate attachments before sending.
 * The Convex runtime cannot run ClamAV directly, so it calls this MTA endpoint.
 *
 * Request:
 *   POST /scan/attachment
 *   Authorization: Bearer <MTA_API_KEY>
 *   Content-Type: application/octet-stream
 *   X-Filename: invoice.pdf   (percent-encoded and bounded to ~1 KiB by the
 *                              caller; see decodeFilenameHeader)
 *
 * Response:
 *   200: { clean: true }
 *   200: { clean: false, virus: "Eicar-Signature", reason: "Malware detected" }
 *   200: { clean: true, skipped: true, reason: "ClamAV unavailable" }
 *   400: { error: "Missing X-Filename header" }
 *   401: { error: "Unauthorized" }
 *   413: { error: "Attachment too large" }
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import { readIntEnv, TCP_PORT_RANGE } from '@owlat/shared/nodeEnv';
import { isRecord } from '@owlat/shared/utils/guards';
import {
	CONTENT_SCREENING_MAX_HTML_BYTES,
	CONTENT_SCREENING_MAX_SUBJECT_CHARS,
	type MtaContentScreeningRequest,
} from '@owlat/mta-protocol/contentScreening';
import type { MtaConfig } from '../config.js';
import { previewScreening } from '../intelligence/contentScreening.js';
import { validateFile } from '@owlat/email-scanner/files';
import { createClamClient, type ClamClient } from '@owlat/email-scanner/clamav';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

const MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_BYTES;

/**
 * Undo the client's percent-encoding of `X-Filename`.
 *
 * An HTTP header value is a ByteString, so a sender-chosen filename with a
 * Cyrillic or CJK character — or a CRLF — cannot be sent raw: the caller
 * (`apps/api/convex/mail/mtaClient.ts`) percent-encodes it, which leaves
 * ordinary ASCII names (and every extension the allowlist below judges)
 * byte-for-byte identical.
 *
 * Falls back to the raw value on a malformed sequence rather than refusing the
 * scan: a lone `%` in a filename is legal, and answering 400 for it would send
 * the caller down its fail-open path and leave the bytes unscanned — the exact
 * outcome the encoding exists to prevent.
 *
 * The caller also BOUNDS the value, because this server runs on Node's default
 * 16 KiB header limit and answers 431 above it — before this route is reached —
 * and a filename is sender-chosen and arrives unbounded. A truncated stem is
 * only ever a shorter log line here; the extension `validateFile` judges is the
 * part the caller keeps.
 */
function decodeFilenameHeader(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** Room for the JSON framing and escaping around the HTML body. */
const CONTENT_REQUEST_MAX_BYTES = CONTENT_SCREENING_MAX_HTML_BYTES * 2;

/** The longest address RFC 5321 allows in a path. */
const MAX_FROM_CHARS = 320;

/** Read a `/scan/content` body, or `null` when it is not one. */
function parseContentRequest(value: unknown): MtaContentScreeningRequest | null {
	if (!isRecord(value)) return null;
	const { from, subject, html } = value;
	if (typeof subject !== 'string' || subject.length > CONTENT_SCREENING_MAX_SUBJECT_CHARS) {
		return null;
	}
	if (typeof html !== 'string' || Buffer.byteLength(html) > CONTENT_SCREENING_MAX_HTML_BYTES) {
		return null;
	}
	if (from !== undefined && (typeof from !== 'string' || from.length > MAX_FROM_CHARS)) {
		return null;
	}
	// Header values: a CR or LF would let the caller write its own headers into
	// the message rspamd scores.
	if (/[\r\n]/.test(subject) || (from && /[\r\n]/.test(from))) return null;
	return { subject, html, ...(from ? { from } : {}) };
}

export function createScanRoutes(config: MtaConfig, redis: Redis): Hono {
	const app = new Hono();

	// All scan routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// The address is validated when the routes are built (boot); the client
	// itself is lazy and starts health checks on the first request.
	const clamHost = process.env['CLAMAV_HOST'] ?? 'clamav';
	const clamPort = readIntEnv(process.env, 'CLAMAV_PORT', { default: 3310, ...TCP_PORT_RANGE });
	let clamClient: ClamClient | null = null;

	function getClamClient(): ClamClient {
		if (!clamClient) {
			clamClient = createClamClient({
				host: clamHost,
				port: clamPort,
				failOpen: true,
				poolSize: 3,
				scanTimeout: 30000,
				connectTimeout: 5000,
				logger: (level, message, meta) => {
					if (level === 'error') logger.error(meta ?? {}, message);
					else if (level === 'warn') logger.warn(meta ?? {}, message);
					else logger.info(meta ?? {}, message);
				},
			});

			clamClient.start();
			logger.info({ host: clamHost, port: clamPort }, 'ClamAV client initialized');
		}
		return clamClient;
	}

	// POST /scan/attachment
	app.post('/attachment', async (c) => {
		const filenameHeader = c.req.header('X-Filename');
		if (!filenameHeader) {
			return c.json({ error: 'Missing X-Filename header' }, 400);
		}
		const filename = decodeFilenameHeader(filenameHeader);

		// Read the binary body
		const body = await c.req.arrayBuffer();

		if (body.byteLength === 0) {
			return c.json({ error: 'Empty attachment body' }, 400);
		}

		if (body.byteLength > MAX_ATTACHMENT_SIZE) {
			return c.json(
				{
					error: `Attachment too large (${Math.round(body.byteLength / 1024 / 1024)}MB > ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB limit)`,
				},
				413
			);
		}

		const buffer = Buffer.from(body);
		const firstBytes = new Uint8Array(buffer.subarray(0, 32));
		// Probe the ISO 9660 descriptor at offset 0x8001 to catch renamed ISOs.
		const isoProbe =
			buffer.length >= 0x8006 ? new Uint8Array(buffer.subarray(0x8001, 0x8006)) : undefined;

		// Step 1: File type validation (fast, pure TS)
		const fileValidation = validateFile(filename, firstBytes, undefined, buffer.length, isoProbe);

		if (!fileValidation.allowed) {
			logger.warn(
				{ filename, reason: fileValidation.reason, detectedType: fileValidation.detectedType },
				'Attachment blocked by file type validation'
			);

			return c.json({
				clean: false,
				reason: fileValidation.reason,
				detectedType: fileValidation.detectedType,
				stage: 'file_type_validation',
			});
		}

		// Step 2: ClamAV malware scan
		const clam = getClamClient();
		const scanResult = await clam.scan(buffer);

		if (scanResult.skipped) {
			logger.warn({ filename, error: scanResult.error }, 'ClamAV scan skipped — failing open');

			return c.json({
				clean: true,
				skipped: true,
				reason: scanResult.error ?? 'ClamAV unavailable',
			});
		}

		if (!scanResult.clean) {
			logger.warn({ filename, virus: scanResult.virus }, 'Malware detected in attachment');

			return c.json({
				clean: false,
				virus: scanResult.virus,
				reason: `Malware detected: ${scanResult.virus}`,
				stage: 'clamav',
			});
		}

		return c.json({ clean: true });
	});

	// POST /scan/content — how content screening would judge this draft. Queues
	// nothing and records nothing; the campaign pre-send check calls it.
	app.post('/content', async (c) => {
		const declared = Number(c.req.header('Content-Length') ?? 0);
		if (declared > CONTENT_REQUEST_MAX_BYTES) {
			return c.json({ error: 'Content too large' }, 413);
		}
		const body = await c.req.arrayBuffer();
		if (body.byteLength > CONTENT_REQUEST_MAX_BYTES) {
			return c.json({ error: 'Content too large' }, 413);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(body).toString('utf-8'));
		} catch {
			return c.json({ error: 'Invalid JSON' }, 400);
		}
		const request = parseContentRequest(parsed);
		if (!request) return c.json({ error: 'Invalid content screening request' }, 400);
		return c.json(await previewScreening(redis, request, config));
	});

	// GET /scan/health — Check ClamAV status
	app.get('/health', async (c) => {
		const clam = getClamClient();
		const status = clam.getStatus();
		const pingOk = await clam.ping();

		return c.json({
			clamav: {
				healthy: status.healthy,
				pingOk,
				activeScanCount: status.activeScanCount,
				pendingCount: status.pendingCount,
			},
		});
	});

	return app;
}
