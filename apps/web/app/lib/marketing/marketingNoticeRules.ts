/**
 * Pure presentation for marketing notices ("Autumn launch finished · 98%
 * delivered", "Sending paused: bounce spike", "Scheduled campaign sends in 15
 * min"): which of a fresh `marketing.notifications.listRecent` answer are new,
 * and what each one says and opens.
 *
 * Copy comes back as catalog KEYS with their values (a value may itself be a
 * key, for the provider names), resolved by the composable at its render
 * boundary: this module is Vue-free so the wording rules are unit-testable.
 * The sentences mirror the Web Push copy (`apps/api/convex/push/marketingCopy.ts`)
 * so a toast and a phone notification about the same thing read the same.
 */

export type MarketingNoticeKind =
	| 'campaign_finished'
	| 'campaign_reminder'
	| 'delivery_hold'
	| 'automation_stalled'
	| 'automation_paused'
	| 'domain_dns';

/** One row of `marketing.notifications.listRecent`. */
export interface MarketingNoticeView {
	id: string;
	kind: MarketingNoticeKind;
	createdAt: number;
	url: string;
	cancelUrl?: string;
	name?: string;
	percent?: number;
	count?: number;
	detail?: string;
	scheduledAt?: number;
}

/** A catalog key with its values; a value given as `{ key }` is itself looked up. */
export interface NoticeText {
	key: string;
	params?: Record<string, string | number | { key: string }>;
}

export type NoticeToastType = 'success' | 'info' | 'warning';

export interface MarketingNoticePresentation {
	title: NoticeText;
	body: NoticeText;
	toastType: NoticeToastType;
	/** Where "Open" goes. */
	href: string;
}

const PREFIX = 'shared.marketingNotices';
const PROVIDERS = new Set(['gmail', 'microsoft', 'yahoo', 'apple', 'other']);

/** Minutes left until a reminder's start, at least one. */
export function minutesUntil(scheduledAt: number, now: number): number {
	return Math.max(1, Math.round((scheduledAt - now) / 60_000));
}

export function presentMarketingNotice(
	notice: MarketingNoticeView,
	now: number
): MarketingNoticePresentation {
	const name = notice.name ?? '';
	const href = notice.url;
	switch (notice.kind) {
		case 'campaign_finished':
			return {
				title: { key: `${PREFIX}.campaignFinished.title` },
				body:
					notice.percent === undefined
						? { key: `${PREFIX}.campaignFinished.bodyNoPercent`, params: { name } }
						: {
								key: `${PREFIX}.campaignFinished.body`,
								params: { name, percent: notice.percent },
							},
				toastType: 'success',
				href,
			};
		case 'campaign_reminder':
			return {
				title: {
					key: `${PREFIX}.campaignReminder.title`,
					params: { minutes: minutesUntil(notice.scheduledAt ?? now, now) },
				},
				body: { key: `${PREFIX}.campaignReminder.body`, params: { name } },
				toastType: 'info',
				href,
			};
		case 'delivery_hold': {
			const provider = PROVIDERS.has(name) ? name : 'other';
			return {
				title: { key: `${PREFIX}.deliveryHold.title` },
				body: {
					key: `${PREFIX}.deliveryHold.body`,
					params: { provider: { key: `${PREFIX}.providers.${provider}` } },
				},
				toastType: 'warning',
				href,
			};
		}
		case 'automation_stalled':
			return {
				title: { key: `${PREFIX}.automationStalled.title` },
				body: {
					key: `${PREFIX}.automationStalled.body`,
					params: { name, count: notice.count ?? 0 },
				},
				toastType: 'warning',
				href,
			};
		case 'automation_paused':
			return {
				title: { key: `${PREFIX}.automationPaused.title` },
				body: { key: `${PREFIX}.automationPaused.body`, params: { name } },
				toastType: 'warning',
				href,
			};
		case 'domain_dns':
			return {
				title: { key: `${PREFIX}.domainDns.title` },
				body: notice.detail
					? { key: `${PREFIX}.domainDns.body`, params: { domain: name, check: notice.detail } }
					: { key: `${PREFIX}.domainDns.bodyNoCheck`, params: { domain: name } },
				toastType: 'warning',
				href,
			};
	}
}

/**
 * The notices in a fresh answer the app has not surfaced yet, oldest first so
 * a burst reads in the order it happened. `seen` is not mutated.
 */
export function freshMarketingNotices(
	notices: readonly MarketingNoticeView[],
	seen: ReadonlySet<string>
): MarketingNoticeView[] {
	return notices.filter((notice) => !seen.has(notice.id)).sort((a, b) => a.createdAt - b.createdAt);
}
