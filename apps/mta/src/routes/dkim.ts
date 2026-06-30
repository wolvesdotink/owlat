/**
 * DKIM key management API routes (master-key protected)
 */

import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as dkimStore from '../smtp/dkimStore.js';
import * as dkimRotation from '../smtp/dkimRotation.js';
import type { DkimRotationNotifier } from '../smtp/dkimRotation.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { notifyConvex } from '../webhooks/convexNotifier.js';

export function createDkimRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All DKIM routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// Push the rotated selector + record back to Convex (RFC 6376 §3.6.1) so the
	// customer learns the new record and `verifyDomain` checks the right host.
	// Fire-and-forget: `notifyConvex` owns its retry/DLQ, and a propagation
	// failure must neither roll back the in-Redis rotation nor block (let alone
	// time out) the rotation API response. We intentionally do NOT await the
	// notifier promise here.
	const notifyRotation: DkimRotationNotifier = (rotation) => {
		void notifyConvex(
			{
				event: 'dkim.rotated',
				domain: rotation.domain,
				selector: rotation.selector,
				dnsRecord: rotation.dnsRecord,
				phase: rotation.phase,
				timestamp: Date.now(),
			},
			config,
			redis
		).catch(() => {});
		return Promise.resolve();
	};

	// Add or update a DKIM key
	app.post('/', async (c) => {
		const body = await c.req.json<{ domain: string; selector: string; privateKey: string }>();
		if (!body.domain || !body.selector || !body.privateKey) {
			return c.json({ error: 'domain, selector, and privateKey are required' }, 400);
		}
		await dkimStore.setDkimKey(redis, body.domain.toLowerCase(), body.selector, body.privateKey);
		return c.json({ success: true, domain: body.domain.toLowerCase(), selector: body.selector });
	});

	// List all DKIM domains (keys redacted)
	app.get('/', async (c) => {
		const domains = await dkimStore.listDkimDomains(redis);
		return c.json({ domains });
	});

	// Remove a DKIM key
	app.delete('/:domain', async (c) => {
		const domain = c.req.param('domain');
		const removed = await dkimStore.removeDkimKey(redis, domain.toLowerCase());
		if (!removed) return c.json({ error: 'DKIM key not found' }, 404);
		return c.json({ success: true });
	});

	// Register a domain's DKIM key (in-app "Add domain" flow — first-time
	// generation). Idempotent: never clobbers an existing key (e.g. one
	// pre-seeded from DKIM_KEYS), it returns the existing selector + record.
	// Use /rotate for deliberate key rotation that replaces the active key.
	app.post('/:domain/register', async (c) => {
		const domain = c.req.param('domain');
		const result = await dkimStore.registerDomainKey(redis, domain.toLowerCase());
		return c.json({ success: true, domain: domain.toLowerCase(), ...result });
	});

	// Rotate key.
	//
	// On a LIVE domain (one that already has an active key) an immediate swap of
	// the signing key would break DKIM on ALL outbound mail until the new public
	// record propagates in DNS (RFC 6376 §3.6 — the verifier looks up the
	// selector's TXT record at sign time). So when a key already exists we
	// delegate to the publish-then-switch overlap workflow (M3AAWG guidance):
	// generate the new key, keep signing with the old one, and only switch once
	// the new selector's DNS record is published (see /rotation/activate).
	//
	// Only a brand-new domain — no active key yet, so nothing to break — gets the
	// key set immediately.
	app.post('/:domain/rotate', async (c) => {
		const domain = c.req.param('domain').toLowerCase();
		const body = await c.req.json<{ selector?: string }>().catch(() => ({} as { selector?: string }));

		const existing = await dkimStore.getDkimConfig(redis, domain);
		if (existing) {
			try {
				const result = await dkimRotation.initiateRotation(redis, domain, {
					selector: body.selector,
					notify: notifyRotation,
				});
				return c.json({
					success: true,
					domain,
					rotation: 'initiated',
					selector: result.selector,
					dnsRecord: result.dnsRecord,
					activateAfter: result.activateAfter.toISOString(),
				});
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : 'Failed to initiate rotation' }, 409);
			}
		}

		const result = await dkimStore.rotateKey(redis, domain, body.selector);
		return c.json({ success: true, domain, rotation: 'immediate', ...result });
	});

	// Initiate a publish-then-switch rotation: generates a new key + selector but
	// keeps signing with the active key until the new record is published in DNS.
	app.post('/:domain/rotation', async (c) => {
		const domain = c.req.param('domain').toLowerCase();
		const body = await c.req.json<{ selector?: string }>().catch(() => ({} as { selector?: string }));
		try {
			const result = await dkimRotation.initiateRotation(redis, domain, {
				selector: body.selector,
				notify: notifyRotation,
			});
			return c.json({
				success: true,
				domain,
				selector: result.selector,
				dnsRecord: result.dnsRecord,
				activateAfter: result.activateAfter.toISOString(),
			});
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : 'Failed to initiate rotation' }, 409);
		}
	});

	// Activate the pending key. DNS-gated: only switches once the new selector's
	// TXT record is published (unless `force` overrides). Returns activated:false
	// while the record is not yet live.
	app.post('/:domain/rotation/activate', async (c) => {
		const domain = c.req.param('domain').toLowerCase();
		const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
		const result = await dkimRotation.activatePendingKey(
			redis,
			domain,
			body.force === true,
			undefined,
			notifyRotation,
		);
		return c.json({ success: true, domain, ...result });
	});

	// Cancel a pending rotation (discard the unpublished pending key).
	app.delete('/:domain/rotation', async (c) => {
		const domain = c.req.param('domain').toLowerCase();
		const cancelled = await dkimRotation.cancelRotation(redis, domain);
		if (!cancelled) return c.json({ error: 'No pending rotation for domain' }, 404);
		return c.json({ success: true, domain });
	});

	return app;
}
