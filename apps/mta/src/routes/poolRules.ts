/**
 * Pool rules management API routes (master-key protected)
 *
 * Manage per-org IP pool routing rules and dedicated IP assignments.
 * Supports domain-scoped rules for fine-grained routing.
 */

import { Hono } from 'hono';
import { v } from 'convex/values';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import * as poolRulesService from '../scaling/poolRules.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { readJsonBody } from '../lib/jsonBody.js';

const poolRuleBody = v.object({
	organizationId: v.string(),
	pool: v.optional(v.union(v.literal('transactional'), v.literal('campaign'))),
	dedicatedIp: v.optional(v.string()),
	fromDomain: v.optional(v.string()),
	toDomain: v.optional(v.string()),
});

export function createPoolRulesRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();

	// All pool-rules routes require the master key (constant-time compare)
	app.use('*', masterKeyAuth(config));

	// Set pool rule for an org (optionally scoped by domain)
	app.post('/', async (c) => {
		const read = await readJsonBody(c, poolRuleBody);
		if (!read.ok) return read.response;
		const body = read.value;

		if (!body.organizationId) {
			return c.json({ error: 'organizationId is required' }, 400);
		}

		if (!body.pool && !body.dedicatedIp) {
			return c.json({ error: 'At least one of pool or dedicatedIp is required' }, 400);
		}

		await poolRulesService.setRule(redis, body.organizationId, {
			pool: body.pool,
			dedicatedIp: body.dedicatedIp,
			fromDomain: body.fromDomain?.toLowerCase(),
			toDomain: body.toDomain?.toLowerCase(),
		});

		return c.json({ success: true });
	});

	// List all pool rules for an org (including domain-scoped)
	app.get('/:orgId/all', async (c) => {
		const orgId = c.req.param('orgId');
		const rules = await poolRulesService.listOrgRules(redis, orgId);
		return c.json({ rules });
	});

	// Get pool rule for an org (optionally scoped)
	app.get('/:orgId', async (c) => {
		const orgId = c.req.param('orgId');
		const fromDomain = c.req.query('fromDomain');
		const toDomain = c.req.query('toDomain');

		const rule = await poolRulesService.getOrgRule(redis, orgId, fromDomain, toDomain);

		if (!rule) {
			return c.json({ rule: null });
		}

		return c.json({ rule });
	});

	// Remove pool rule for an org (optionally scoped)
	app.delete('/:orgId', async (c) => {
		const orgId = c.req.param('orgId');
		const fromDomain = c.req.query('fromDomain');
		const toDomain = c.req.query('toDomain');

		const removed = await poolRulesService.removeRule(redis, orgId, fromDomain, toDomain);
		return c.json({ success: true, removed });
	});

	return app;
}
