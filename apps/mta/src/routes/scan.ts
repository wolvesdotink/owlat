/**
 * POST /scan/attachment — Scan an attachment for malware and dangerous file types
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
 *   X-Filename: invoice.pdf
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
import type { MtaConfig } from '../config.js';
import { validateFile } from '@owlat/email-scanner/files';
import { createClamClient, type ClamClient } from '@owlat/email-scanner/clamav';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { logger } from '../monitoring/logger.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';

const MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_BYTES;

export function createScanRoutes(config: MtaConfig): Hono {
	const app = new Hono();

	// All scan routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// Initialize ClamAV client (lazy — starts health checks on first request)
	let clamClient: ClamClient | null = null;

	function getClamClient(): ClamClient {
		if (!clamClient) {
			const clamHost = process.env['CLAMAV_HOST'] ?? 'clamav';
			const clamPort = parseInt(process.env['CLAMAV_PORT'] ?? '3310', 10);

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
		const filename = c.req.header('X-Filename');
		if (!filename) {
			return c.json({ error: 'Missing X-Filename header' }, 400);
		}

		// Read the binary body
		const body = await c.req.arrayBuffer();

		if (body.byteLength === 0) {
			return c.json({ error: 'Empty attachment body' }, 400);
		}

		if (body.byteLength > MAX_ATTACHMENT_SIZE) {
			return c.json({
				error: `Attachment too large (${Math.round(body.byteLength / 1024 / 1024)}MB > ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)}MB limit)`,
			}, 413);
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
			logger.warn(
				{ filename, error: scanResult.error },
				'ClamAV scan skipped — failing open'
			);

			return c.json({
				clean: true,
				skipped: true,
				reason: scanResult.error ?? 'ClamAV unavailable',
			});
		}

		if (!scanResult.clean) {
			logger.warn(
				{ filename, virus: scanResult.virus },
				'Malware detected in attachment'
			);

			return c.json({
				clean: false,
				virus: scanResult.virus,
				reason: `Malware detected: ${scanResult.virus}`,
				stage: 'clamav',
			});
		}

		return c.json({ clean: true });
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
