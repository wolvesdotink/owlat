/**
 * Reactive MTA infrastructure health cache.
 *
 * Convex queries cannot fetch the MTA directly, so a short cron action polls
 * its public health endpoint and stores only non-secret operational signals on
 * the instance-settings singleton. Delivery queries can then include the same
 * worker, DNS, Redis, emergency, and per-IP SMTP readiness that operators see
 * at the source.
 */

import { isRecord } from '@owlat/shared';
import type { Infer } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, internalMutation } from '../_generated/server';
import { upsertInstanceSettings } from '../lib/instanceSettings';
import { getMtaBaseUrl } from '../mail/mtaClient';
import { mtaHealthSnapshotValidator } from '../schema/instance';

type Snapshot = Infer<typeof mtaHealthSnapshotValidator>;

export function parseHealth(value: unknown, observedAt: number): Snapshot | null {
	if (!isRecord(value)) return null;
	const worker = isRecord(value['worker']) ? value['worker'] : null;
	const emergency = isRecord(value['emergency']) ? value['emergency'] : null;
	const smtp = isRecord(value['smtpOutbound']) ? value['smtpOutbound'] : null;
	const smtpTls = isRecord(value['smtpTls']) ? value['smtpTls'] : null;
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
	if (
		smtpTls &&
		((smtpTls['status'] !== 'pass' &&
			smtpTls['status'] !== 'warn' &&
			smtpTls['status'] !== 'fail') ||
			typeof smtpTls['hostname'] !== 'string' ||
			typeof smtpTls['isHostnameMatched'] !== 'boolean' ||
			typeof smtpTls['checkedAt'] !== 'number')
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
			...(item['sourceBinding'] === 'bound' || item['sourceBinding'] === 'nat'
				? { sourceBinding: item['sourceBinding'] }
				: {}),
		});
	}

	const parsedTls: Snapshot['smtpTls'] | undefined = smtpTls
		? {
				status: smtpTls['status'] as 'pass' | 'warn' | 'fail',
				hostname: smtpTls['hostname'] as string,
				isHostnameMatched: smtpTls['isHostnameMatched'] as boolean,
				...(typeof smtpTls['validFrom'] === 'number' ? { validFrom: smtpTls['validFrom'] } : {}),
				...(typeof smtpTls['validTo'] === 'number' ? { validTo: smtpTls['validTo'] } : {}),
				...(typeof smtpTls['reason'] === 'string' ? { reason: smtpTls['reason'] } : {}),
				checkedAt: smtpTls['checkedAt'] as number,
			}
		: undefined;
	return {
		status: value['status'],
		isRedisConnected: value['redis'] === 'connected',
		isWorkerAlive: worker['alive'],
		isDnsReachable: value['dns'] === 'ok',
		isAllIpsBlocked: emergency['allIpsBlocked'],
		smtpOutbound: { status: smtp['status'], checkedAt: smtp['checkedAt'], ips },
		...(parsedTls ? { smtpTls: parsedTls } : {}),
		observedAt,
	};
}

export const sync = internalAction({
	args: {},
	handler: async (ctx): Promise<void> => {
		// `/health` is unauthenticated, so the key is not required here.
		const baseUrl = getMtaBaseUrl();
		if (!baseUrl) return;

		const observedAt = Date.now();
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 5_000);
		let snapshot: Snapshot;
		try {
			const response = await fetch(`${baseUrl}/health`, {
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
	args: { snapshot: mtaHealthSnapshotValidator },
	handler: async (ctx, args): Promise<void> => {
		// Often the first writer on a fresh deployment: the helper creates a bare
		// row without the seed columns, so `/seed/admin` still fills them later.
		await upsertInstanceSettings(ctx, { mtaHealth: args.snapshot });
	},
});
