/**
 * Reactive MTA infrastructure health cache.
 *
 * Convex queries cannot fetch the MTA directly, so a short cron action polls
 * its public health endpoint and stores only non-secret operational signals on
 * the `mtaHealth` row of `instanceCounters`. Delivery queries can then include the same
 * worker, DNS, Redis, emergency, and per-IP SMTP readiness that operators see
 * at the source.
 */

import { isRecord } from '@owlat/shared';
import type { Infer } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, internalMutation } from '../_generated/server';
import { readInstanceCounter, writeInstanceCounter } from '../lib/instanceCounters';
import { getMtaBaseUrl } from '../mail/mtaClient';
import { mtaHealthSnapshotValidator } from '../schema/instance';
import { canSkipMtaHealthWrite } from './mtaHealthFreshness';

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
		// The snapshot has its own counter row (plan 2.4), so it no longer
		// re-runs feature-gated queries. A poll that only refreshed timestamps is
		// still not written until the stored snapshot needs a re-stamp (see
		// mtaHealthFreshness.ts): the Delivery surfaces subscribe to the row.
		const { mtaHealth: stored } = await readInstanceCounter(ctx.db, 'mtaHealth');
		if (canSkipMtaHealthWrite(stored, args.snapshot)) return;
		await writeInstanceCounter(ctx, 'mtaHealth', { mtaHealth: args.snapshot });
	},
});
