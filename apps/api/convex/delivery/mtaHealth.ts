/**
 * Reactive MTA infrastructure health cache.
 *
 * Convex queries cannot fetch the MTA directly, so a short cron action polls
 * its public health endpoint and stores only non-secret operational signals on
 * the instance-settings singleton. Delivery queries can then include the same
 * worker, DNS, Redis, emergency, and per-IP SMTP readiness that operators see
 * at the source.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, internalMutation } from '../_generated/server';
import { getOptional } from '../lib/env';

const ipResultValidator = v.object({
	ip: v.string(),
	status: v.union(v.literal('ok'), v.literal('failed')),
	reason: v.optional(v.string()),
});

const snapshotValidator = v.object({
	status: v.union(v.literal('ok'), v.literal('degraded'), v.literal('unreachable')),
	isRedisConnected: v.optional(v.boolean()),
	isWorkerAlive: v.optional(v.boolean()),
	isDnsReachable: v.optional(v.boolean()),
	isAllIpsBlocked: v.optional(v.boolean()),
	smtpOutbound: v.optional(
		v.object({
			status: v.union(v.literal('ok'), v.literal('degraded')),
			checkedAt: v.number(),
			ips: v.array(ipResultValidator),
		})
	),
	observedAt: v.number(),
});

type Snapshot = {
	status: 'ok' | 'degraded' | 'unreachable';
	isRedisConnected?: boolean;
	isWorkerAlive?: boolean;
	isDnsReachable?: boolean;
	isAllIpsBlocked?: boolean;
	smtpOutbound?: {
		status: 'ok' | 'degraded';
		checkedAt: number;
		ips: Array<{ ip: string; status: 'ok' | 'failed'; reason?: string }>;
	};
	observedAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseHealth(value: unknown, observedAt: number): Snapshot | null {
	if (!isRecord(value)) return null;
	const worker = isRecord(value['worker']) ? value['worker'] : null;
	const emergency = isRecord(value['emergency']) ? value['emergency'] : null;
	const smtp = isRecord(value['smtpOutbound']) ? value['smtpOutbound'] : null;
	if (
		(value['status'] !== 'ok' && value['status'] !== 'degraded') ||
		(value['redis'] !== 'connected' && value['redis'] !== 'disconnected') ||
		typeof worker?.['alive'] !== 'boolean' ||
		(value['dns'] !== 'ok' && value['dns'] !== 'unreachable') ||
		typeof emergency?.['allIpsBlocked'] !== 'boolean' ||
		(smtp?.['status'] !== 'ok' && smtp?.['status'] !== 'degraded') ||
		typeof smtp['checkedAt'] !== 'number' ||
		!Array.isArray(smtp['ips'])
	) {
		return null;
	}

	const ips: NonNullable<Snapshot['smtpOutbound']>['ips'] = [];
	for (const item of smtp['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string') return null;
		if (item['status'] !== 'ok' && item['status'] !== 'failed') return null;
		ips.push({
			ip: item['ip'],
			status: item['status'],
			...(typeof item['reason'] === 'string' ? { reason: item['reason'] } : {}),
		});
	}

	return {
		status: value['status'],
		isRedisConnected: value['redis'] === 'connected',
		isWorkerAlive: worker['alive'],
		isDnsReachable: value['dns'] === 'ok',
		isAllIpsBlocked: emergency['allIpsBlocked'],
		smtpOutbound: { status: smtp['status'], checkedAt: smtp['checkedAt'], ips },
		observedAt,
	};
}

export const sync = internalAction({
	args: {},
	handler: async (ctx): Promise<void> => {
		const baseUrl = getOptional('MTA_INTERNAL_URL') ?? getOptional('MTA_API_URL');
		if (!baseUrl) return;

		const observedAt = Date.now();
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 5_000);
		let snapshot: Snapshot;
		try {
			const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
				signal: ctrl.signal,
			});
			const parsed = response.ok ? parseHealth(await response.json(), observedAt) : null;
			snapshot = parsed ?? { status: 'unreachable', observedAt };
		} catch {
			snapshot = { status: 'unreachable', observedAt };
		} finally {
			clearTimeout(timer);
		}

		await ctx.runMutation(internal.delivery.mtaHealth.record, { snapshot });
	},
});

export const record = internalMutation({
	args: { snapshot: snapshotValidator },
	handler: async (ctx, args): Promise<void> => {
		const settings = await ctx.db.query('instanceSettings').first(); // bounded: singleton row
		if (settings) {
			await ctx.db.patch(settings._id, { mtaHealth: args.snapshot, updatedAt: Date.now() });
		} else {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: args.snapshot,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
	},
});
