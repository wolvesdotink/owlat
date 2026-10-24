/**
 * Pure presentation for marketing notices ("Autumn launch finished · 98%
 * delivered", "Bounce spike: sending protection on", "Scheduled campaign sends in 15
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
	/**
	 * The last instant the notice holds by the clock alone (a reminder until
	 * its start, a delivery hold while its breaker snapshot is trusted). The
	 * subscription is not re-run as time passes, so a kept answer can carry a
	 * notice that has expired since.
	 */
	liveUntil?: number;
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

/** Catalog group per kind, for the copy that differs only by kind. */
const KIND_KEY: Record<MarketingNoticeKind, string> = {
	campaign_finished: 'campaignFinished',
	campaign_reminder: 'campaignReminder',
	delivery_hold: 'deliveryHold',
	automation_stalled: 'automationStalled',
	automation_paused: 'automationPaused',
	domain_dns: 'domainDns',
};

/** What an OS notification says, and the page it opens when clicked. */
export interface NativeMarketingNotice {
	title: NoticeText;
	body: NoticeText;
	href: string;
}

/**
 * The OS notification for a notice. It can land on a lock screen, so with
 * private notifications on (the shared "hide message previews" switch) its
 * body names no campaign, automation or domain, the same rule Web Push follows.
 * Titles name none to begin with; the provider of a delivery hold is not
 * private. The in-app toast is in front of the person already and keeps the
 * names.
 */
export function presentNativeMarketingNotice(
	notice: MarketingNoticeView,
	now: number,
	isPrivate: boolean
): NativeMarketingNotice {
	const { title, body, href } = presentMarketingNotice(notice, now);
	if (!isPrivate || notice.kind === 'delivery_hold') return { title, body, href };
	return { title, body: { key: `${PREFIX}.${KIND_KEY[notice.kind]}.private` }, href };
}

/**
 * Whether a notice is still worth an OS notification now. The reader dropped
 * the notices that no longer held when it answered; one that expires by the
 * clock alone (`liveUntil`) can still turn stale on this side of it while the
 * answer is kept, and a reminder always does once its campaign's start has
 * passed.
 */
export function isNativeNoticeCurrent(notice: MarketingNoticeView, now: number): boolean {
	if (notice.liveUntil !== undefined && now > notice.liveUntil) return false;
	return notice.kind !== 'campaign_reminder' || (notice.scheduledAt ?? 0) > now;
}

export type QuietRelease =
	| { kind: 'none' }
	| { kind: 'single'; notice: MarketingNoticeView }
	| { kind: 'summary'; count: number };

/**
 * What to send once quiet hours end, for the notices whose OS notification the
 * window held back. Only the ones the reader still returns count (a reminder
 * whose campaign was cancelled meanwhile, or a hold that cleared, is gone from
 * it), minus the ones past their `liveUntil`: the answer may be hours old, and a
 * reminder whose start passed or a hold whose breaker snapshot went stale
 * changes no row the reader depends on. One goes out as itself, with its link;
 * several as one summary, so the morning does not open with a stack.
 */
export function planQuietRelease(
	held: ReadonlySet<string>,
	current: readonly MarketingNoticeView[],
	now: number
): QuietRelease {
	const due = current.filter((notice) => held.has(notice.id) && isNativeNoticeCurrent(notice, now));
	if (due.length === 0) return { kind: 'none' };
	if (due.length === 1) return { kind: 'single', notice: due[0]! };
	return { kind: 'summary', count: due.length };
}
