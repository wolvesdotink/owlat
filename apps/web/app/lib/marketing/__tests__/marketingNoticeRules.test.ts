/**
 * What each marketing notice says in the app and where it opens, resolved
 * through the real English catalog so the assertions read as the toast does.
 */
import { describe, expect, it } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import {
	freshMarketingNotices,
	isNativeNoticeCurrent,
	planQuietRelease,
	presentMarketingNotice,
	presentNativeMarketingNotice,
	type MarketingNoticeView,
	type NoticeText,
} from '../marketingNoticeRules';

const { t } = createTestI18n().global;

function resolve(text: NoticeText): string {
	const params: Record<string, string | number> = {};
	for (const [name, value] of Object.entries(text.params ?? {})) {
		params[name] = typeof value === 'object' ? t(value.key) : value;
	}
	const count = params['count'];
	return typeof count === 'number' ? t(text.key, params, count) : t(text.key, params);
}

function render(notice: Partial<MarketingNoticeView> & Pick<MarketingNoticeView, 'kind'>, now = 0) {
	const presentation = presentMarketingNotice(
		{ id: 'n1', createdAt: 0, url: '/dashboard/x', ...notice },
		now
	);
	return {
		title: resolve(presentation.title),
		body: resolve(presentation.body),
		toastType: presentation.toastType,
		href: presentation.href,
	};
}

describe('presentMarketingNotice', () => {
	it('says how much of a finished campaign was delivered, or just that it finished', () => {
		expect(render({ kind: 'campaign_finished', name: 'Autumn launch', percent: 98 })).toEqual({
			title: 'Campaign finished',
			body: 'Autumn launch · 98% delivered',
			toastType: 'success',
			href: '/dashboard/x',
		});
		expect(render({ kind: 'campaign_finished', name: 'Autumn launch' }).body).toBe(
			'Autumn launch has finished sending'
		);
	});

	it('counts down a reminder from now', () => {
		const rendered = render(
			{ kind: 'campaign_reminder', name: 'Webinar', scheduledAt: 14 * 60_000 + 20_000 },
			0
		);
		expect(rendered.title).toBe('Scheduled campaign sends in 14 min');
		expect(rendered.body).toBe('Webinar');
		expect(rendered.toastType).toBe('info');
	});

	it('names the provider of a hold and pluralises stalled contacts', () => {
		expect(render({ kind: 'delivery_hold', name: 'microsoft' }).body).toBe(
			'Owlat is holding back mail to Microsoft, or rerouting it through your relay, after a spike in bounces or complaints'
		);
		expect(render({ kind: 'delivery_hold', name: 'unknown' }).body).toContain('other providers');
		expect(render({ kind: 'automation_stalled', name: 'Welcome', count: 1 }).body).toBe(
			'Welcome: 1 stalled contact'
		);
		expect(render({ kind: 'automation_stalled', name: 'Welcome', count: 12 }).body).toBe(
			'Welcome: 12 stalled contacts'
		);
		expect(render({ kind: 'automation_paused', name: 'Welcome' }).title).toBe('Automation paused');
	});

	it('names the failing DNS check when it is known', () => {
		expect(
			render({ kind: 'domain_dns', name: 'mail.example.com', detail: 'SPF with -all' }).body
		).toBe('mail.example.com: SPF with -all check failed');
		expect(render({ kind: 'domain_dns', name: 'mail.example.com' }).body).toBe(
			'mail.example.com: a DNS check failed'
		);
	});
});

describe('freshMarketingNotices', () => {
	it('keeps the unseen ones, oldest first', () => {
		const notices: MarketingNoticeView[] = [
			{ id: 'c', kind: 'campaign_finished', createdAt: 3, url: '/' },
			{ id: 'b', kind: 'campaign_finished', createdAt: 2, url: '/' },
			{ id: 'a', kind: 'campaign_finished', createdAt: 1, url: '/' },
		];
		expect(freshMarketingNotices(notices, new Set(['b'])).map((n) => n.id)).toEqual(['a', 'c']);
	});
});

const view = (notice: Partial<MarketingNoticeView> & Pick<MarketingNoticeView, 'kind'>) => ({
	id: 'n1',
	createdAt: 0,
	url: '/dashboard/x',
	...notice,
});

describe('presentNativeMarketingNotice', () => {
	it('is the in-app copy with its link while notifications are not private', () => {
		const notice = view({
			kind: 'automation_paused',
			name: 'Welcome',
			url: '/dashboard/automations/a1',
		});
		const native = presentNativeMarketingNotice(notice, 0, false);
		expect(resolve(native.body)).toBe(render(notice).body);
		expect(native.href).toBe('/dashboard/automations/a1');
	});

	it.each([
		['campaign_finished', 'Secret launch', 'A campaign has finished sending'],
		['campaign_reminder', 'Secret launch', 'Open it to review or cancel the send'],
		['automation_stalled', 'Secret flow', 'Contacts stalled in an automation'],
		['automation_paused', 'Secret flow', 'An automation paused itself after repeated failed runs'],
		['domain_dns', 'secret.example.com', 'A DNS check of a sending domain failed'],
	] as const)('names no %s on the lock screen when private', (kind, name, body) => {
		const native = presentNativeMarketingNotice(
			view({ kind, name, count: 3, scheduledAt: 15 * 60_000, detail: 'SPF' }),
			0,
			true
		);
		expect(resolve(native.title)).not.toContain(name);
		expect(resolve(native.body)).toBe(body);
		expect(native.href).toBe('/dashboard/x');
	});

	it('keeps the provider of a delivery hold, which is not private', () => {
		const native = presentNativeMarketingNotice(
			view({ kind: 'delivery_hold', name: 'gmail' }),
			0,
			true
		);
		expect(resolve(native.body)).toContain('Gmail');
	});
});

describe('quiet hours release', () => {
	const reminder = view({ id: 'r', kind: 'campaign_reminder', scheduledAt: 1_000 });

	it('treats a reminder past its start as stale, anything else as current', () => {
		expect(isNativeNoticeCurrent(reminder, 999)).toBe(true);
		expect(isNativeNoticeCurrent(reminder, 1_000)).toBe(false);
		expect(isNativeNoticeCurrent(view({ kind: 'domain_dns' }), 1_000_000)).toBe(true);
	});

	it('treats any notice past its liveUntil as stale, the deadline itself included as live', () => {
		const hold = view({ kind: 'delivery_hold', name: 'gmail', liveUntil: 600_000 });
		expect(isNativeNoticeCurrent(hold, 600_000)).toBe(true);
		expect(isNativeNoticeCurrent(hold, 600_001)).toBe(false);
	});

	it('sends nothing, one notice as itself, or several as one summary', () => {
		const a = view({ id: 'a', kind: 'campaign_finished' });
		const b = view({ id: 'b', kind: 'domain_dns' });
		expect(planQuietRelease(new Set(), [a, b], 0)).toEqual({ kind: 'none' });
		expect(planQuietRelease(new Set(['a']), [a, b], 0)).toEqual({ kind: 'single', notice: a });
		expect(planQuietRelease(new Set(['a', 'b']), [a, b], 0)).toEqual({ kind: 'summary', count: 2 });
	});

	it('leaves out what the reader no longer returns and reminders that went stale', () => {
		const a = view({ id: 'a', kind: 'campaign_finished' });
		expect(planQuietRelease(new Set(['gone', 'r', 'a']), [reminder, a], 2_000)).toEqual({
			kind: 'single',
			notice: a,
		});
		expect(planQuietRelease(new Set(['gone', 'r']), [reminder], 2_000)).toEqual({ kind: 'none' });
	});

	it('leaves out a hold whose breaker snapshot went stale while the answer was kept', () => {
		const a = view({ id: 'a', kind: 'campaign_finished' });
		const hold = view({ id: 'h', kind: 'delivery_hold', name: 'gmail', liveUntil: 1_000 });
		expect(planQuietRelease(new Set(['a', 'h']), [hold, a], 1_000)).toEqual({
			kind: 'summary',
			count: 2,
		});
		expect(planQuietRelease(new Set(['a', 'h']), [hold, a], 1_001)).toEqual({
			kind: 'single',
			notice: a,
		});
	});
});
