/**
 * The reads the campaign send orchestrator's PREP step (`send.ts:
 * startCampaignSend`) makes: the content scan with its Safe Browsing verdict
 * cache, and the public archive snapshot the preparation commit stores.
 */

import { nanoid } from 'nanoid';
import {
	checkUrlReputation,
	urlReputationToFlags,
	type ContentFlag,
	type UrlReputationCache,
} from '@owlat/email-scanner';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { getOptional } from '../lib/env';
import { composeForSend } from '../delivery/sendComposition';
import type { ArchiveSnapshot } from './archiveQueries';
import { combineContentScan, type ContentScanVerdict } from './sendPlanning';
import { scanPublishableVariants } from '../transactional/lifecycleReducer';
import { htmlTranslationEntries } from '../lib/emailJson';

// Convex-backed implementation of the email-scanner's `UrlReputationCache`,
// persisting Safe Browsing verdicts in the `urlReputationCache` table so
// repeated links across campaign content scans are served from cache rather
// than re-querying Google. `get` honors the stored TTL (a miss past expiry);
// `set` upserts by url hash. Caching is best-effort — a cache read/write
// failure must not abort the scan, so both paths swallow errors and degrade to
// an uncached check.
export function makeUrlReputationCache(ctx: ActionCtx): UrlReputationCache {
	return {
		async get(urlHash) {
			try {
				return await ctx.runQuery(internal.campaigns.sendQueries.getUrlReputationVerdict, {
					urlHash,
				});
			} catch {
				return null;
			}
		},
		async set(urlHash, verdict) {
			try {
				// checkpoint: a best-effort verdict cache, not campaign state; a write
				// that stands after the send fails costs nothing but a cache hit.
				await ctx.runMutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
					urlHash,
					verdict: verdict.verdict,
					source: verdict.source,
					threats: verdict.threats,
					checkedAt: verdict.checkedAt,
					expiresAt: verdict.expiresAt,
				});
			} catch {
				// Best-effort cache write — ignore.
			}
		},
	};
}

/**
 * The public archive copy, when the campaign archives (its own setting, else
 * the org's `campaigns.archive` default) and SITE_URL is set. The "view in
 * browser" URL is re-derived per page by the walker from the stored
 * `archiveToken`, so only the snapshot is composed here.
 */
export async function composeArchiveSnapshot(
	ctx: ActionCtx,
	campaign: Doc<'campaigns'>,
	subject: string,
	htmlContent: string
): Promise<ArchiveSnapshot | undefined> {
	const siteUrl = getOptional('SITE_URL');
	if (!siteUrl) return undefined;
	const resolvedFlags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
	const archiveEnabled = campaign.archiveEnabled ?? resolvedFlags['campaigns.archive'] ?? false;
	if (!archiveEnabled) return undefined;
	const composed = composeForSend({
		kind: 'archive_snapshot',
		template: { subject, htmlContent },
	});
	return { archiveToken: nanoid(24), archiveHtmlContent: composed.html, archiveSubject: subject };
}

/**
 * The content verdict for what a campaign sends: the scanner's score plus the
 * URL reputation flags. The walker sends each recipient the translation for
 * their language (`sendQueries.getEmailTemplateForLanguage`), so every stored
 * translation is scanned, and its links checked, with the default; the
 * campaign's subject override replaces the subject of each.
 */
export async function scanCampaignContent(
	ctx: ActionCtx,
	campaign: Pick<Doc<'campaigns'>, 'subject'>,
	template: Pick<Doc<'emailTemplates'>, 'subject' | 'htmlTranslations'>,
	htmlContent: string
): Promise<ContentScanVerdict> {
	const base = scanPublishableVariants(
		template.subject,
		htmlContent,
		template.htmlTranslations,
		campaign.subject
	);

	const safeBrowsingApiKey = getOptional('GOOGLE_SAFE_BROWSING_API_KEY');
	let urlFlags: ContentFlag[] = [];
	if (safeBrowsingApiKey) {
		try {
			const sentHtml = [
				htmlContent,
				...htmlTranslationEntries(template.htmlTranslations).map((entry) => entry.htmlContent),
			].join('\n');
			const urlResults = await checkUrlReputation(sentHtml, {
				apiKey: safeBrowsingApiKey,
				cache: makeUrlReputationCache(ctx),
			});
			urlFlags = urlReputationToFlags(urlResults);
		} catch {
			// URL reputation check failure should not block campaign sending
		}
	}
	return combineContentScan(base, urlFlags);
}
