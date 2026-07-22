import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import { logWarn } from '../../lib/runtimeLog';
import { scheduleFanout, type FanoutSpec } from '../../webhooks/scheduleFanout';
import {
	recordContactActivity,
	type MetadataFor,
	type RecordContactActivityArgs,
} from '../../contactActivities/writer';
import type { ContactActivityType } from '../../contactActivities/catalog';
import { bumpSendDailyStat } from '../../lib/sendDailyStats';
import { bumpCampaignStats } from '../../campaigns/statShards';
import { normalizeEmail } from '../../lib/inputGuards';
import { scheduleSuppressionMirror } from '../suppressionMirror';
import type { SendRef } from './types';

// ─── Effects (a discriminated list returned by reducers) ────────────────────

/**
 * Per-lifecycle wrapper around the shared `RecordContactActivityArgs`
 * distributed union. Every lifecycle that writes contact activity rows
 * (Send, DOI, Topic subscription) uses this same effect kind; the
 * runner just calls `recordContactActivity` with the variant.
 */
type ContactActivityEffect = {
	[L in ContactActivityType]: {
		kind: 'contact_activity';
		literal: L;
		contactId: Id<'contacts'>;
		metadata: MetadataFor<L>;
		occurredAt: number;
	};
}[ContactActivityType];

export type Effect =
	| {
			kind: 'blocklist_insert';
			email: string;
			reason: 'bounced' | 'complained';
			bounceType?: 'hard' | 'soft';
			source: SendRef;
	  }
	| {
			// Overwrite the recipient contact's running soft-bounce counter
			// (set to an absolute value, computed by the reducer from the
			// already-loaded contact). `count: 0` is the delivered reset.
			kind: 'contact_soft_bounce_count';
			contactId: Id<'contacts'>;
			count: number;
	  }
	| ContactActivityEffect
	| {
			kind: 'campaign_stats_bounced';
			campaignId: Id<'campaigns'>;
			isHard: boolean;
			previousBounceType?: 'soft';
			at: number;
	  }
	| {
			kind: 'campaign_stats_sent';
			campaignId: Id<'campaigns'>;
	  }
	| {
			kind: 'campaign_stats_failed';
			campaignId: Id<'campaigns'>;
	  }
	| {
			kind: 'campaign_stats_delivered';
			campaignId: Id<'campaigns'>;
			at: number;
	  }
	| {
			kind: 'campaign_stats_opened';
			campaignId: Id<'campaigns'>;
			at: number;
	  }
	| {
			kind: 'campaign_stats_clicked';
			campaignId: Id<'campaigns'>;
			at: number;
	  }
	| {
			kind: 'content_scan_complaint';
			campaignId: Id<'campaigns'>;
			contactEmail: string;
	  }
	| {
			kind: 'reputation_update';
			eventType: 'send' | 'deliver' | 'bounce' | 'hard_bounce' | 'complaint';
			domain?: string;
	  }
	| {
			kind: 'attachment_cleanup';
			storageIds: ReadonlyArray<string>;
	  }
	| {
			kind: 'daily_stats_bump';
			field: 'sent' | 'delivered' | 'opened' | 'clicked';
			at: number;
	  }
	| {
			kind: 'customer_webhook';
			spec: FanoutSpec;
	  };

// ─── Runner — applies the patch, dispatches effects, schedules fanout ───────

export async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'blocklist_insert': {
				const normalized = normalizeEmail(effect.email);
				const existing = await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', normalized))
					.first();
				if (existing) {
					// A threshold-created soft suppression can later receive decisive
					// hard-bounce evidence. Preserve the single blocklist row while
					// upgrading both its classification and provenance; the hard mirror
					// refresh below also changes the MTA backstop from expiring to permanent.
					if (
						existing.reason !== 'bounced' ||
						existing.bounceType !== 'soft' ||
						effect.reason !== 'bounced' ||
						effect.bounceType !== 'hard'
					) {
						break;
					}
					await ctx.db.patch(existing._id, {
						bounceType: 'hard',
						sourceType: effect.source.kind === 'campaign' ? 'emailSend' : 'transactionalSend',
						sourceEmailSendId: effect.source.kind === 'campaign' ? effect.source.id : undefined,
						sourceTransactionalSendId:
							effect.source.kind === 'transactional' ? effect.source.id : undefined,
					});
					await scheduleSuppressionMirror(ctx, {
						email: normalized,
						reason: 'bounced',
						bounceType: 'hard',
					});
					break;
				}
				await ctx.db.insert('blockedEmails', {
					email: normalized,
					reason: effect.reason,
					...(effect.bounceType ? { bounceType: effect.bounceType } : {}),
					sourceType: effect.source.kind === 'campaign' ? 'emailSend' : 'transactionalSend',
					...(effect.source.kind === 'campaign'
						? { sourceEmailSendId: effect.source.id }
						: { sourceTransactionalSendId: effect.source.id }),
					createdAt: Date.now(),
				});
				// Mirror this suppression to the MTA's Redis backstop so the
				// last-hop dispatch check can catch the automation/agent
				// outbound paths that bypass the app-level blocklist check
				// (the MTA list is otherwise fed only by MTA-internal events).
				// Fire-and-forget; never rolls back the insert.
				await scheduleSuppressionMirror(ctx, {
					email: normalized,
					reason: effect.reason,
					...(effect.bounceType ? { bounceType: effect.bounceType } : {}),
				});
				break;
			}
			case 'contact_soft_bounce_count': {
				await ctx.db.patch(effect.contactId, {
					softBounceCount: effect.count,
				});
				break;
			}
			case 'contact_activity': {
				// Correlated-unions: TS widens `literal`/`metadata` once the
				// effect variant is destructured. The source-side effect type
				// (`ContactActivityEffect`) already enforces the correlation,
				// so the cast is safe.
				const args: RecordContactActivityArgs = {
					literal: effect.literal,
					contactId: effect.contactId,
					metadata: effect.metadata,
					occurredAt: effect.occurredAt,
				} as RecordContactActivityArgs;
				await recordContactActivity(ctx, args);
				break;
			}
			// campaign_stats_* events bump a RANDOM shard of campaignStatShards
			// (not the single campaigns row) so a blast's per-recipient counter
			// writes don't contend; a rollup cron sums shards into campaigns.stats*.
			case 'campaign_stats_bounced': {
				await bumpCampaignStats(
					ctx,
					effect.campaignId,
					effect.previousBounceType === 'soft'
						? { statsSoftBounced: -1, statsHardBounced: 1 }
						: {
								statsBounced: 1,
								...(effect.isHard ? { statsHardBounced: 1 } : { statsSoftBounced: 1 }),
							}
				);
				break;
			}
			case 'campaign_stats_sent': {
				await bumpCampaignStats(ctx, effect.campaignId, { statsSent: 1 });
				break;
			}
			case 'campaign_stats_failed': {
				await bumpCampaignStats(ctx, effect.campaignId, { statsFailed: 1 });
				break;
			}
			case 'campaign_stats_delivered': {
				await bumpCampaignStats(ctx, effect.campaignId, { statsDelivered: 1 });
				break;
			}
			case 'campaign_stats_opened': {
				await bumpCampaignStats(ctx, effect.campaignId, { statsOpened: 1 });
				break;
			}
			case 'campaign_stats_clicked': {
				await bumpCampaignStats(ctx, effect.campaignId, { statsClicked: 1 });
				break;
			}
			case 'content_scan_complaint': {
				const scan = await ctx.db
					.query('contentScanResults')
					.withIndex('by_resource', (q) =>
						q.eq('resourceType', 'campaign').eq('resourceId', effect.campaignId)
					)
					.first();
				if (!scan) break;
				await ctx.db.patch(scan._id, {
					flags: [
						...scan.flags,
						{
							type: 'suspicious_pattern' as const,
							severity: 'low' as const,
							description: 'Spam complaint received (feedback loop)',
							match: effect.contactEmail,
						},
					],
				});
				break;
			}
			case 'reputation_update': {
				await ctx.scheduler.runAfter(0, internal.analytics.sendingReputation.recordEvent, {
					eventType: effect.eventType,
					...(effect.domain ? { domain: effect.domain } : {}),
				});
				break;
			}
			case 'attachment_cleanup': {
				for (const storageId of effect.storageIds) {
					try {
						await ctx.storage.delete(storageId as Id<'_storage'>);
					} catch (err) {
						logWarn(`[sendLifecycle] failed to delete attachment blob ${storageId}:`, err);
					}
				}
				break;
			}
			case 'daily_stats_bump': {
				await bumpSendDailyStat(ctx, effect.field, effect.at);
				break;
			}
			case 'customer_webhook': {
				await scheduleFanout(ctx, effect.spec);
				break;
			}
		}
	}
}
