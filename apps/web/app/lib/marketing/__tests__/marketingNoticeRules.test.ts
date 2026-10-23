/**
 * What each marketing notice says in the app and where it opens, resolved
 * through the real English catalog so the assertions read as the toast does.
 */
import { describe, expect, it } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import {
	freshMarketingNotices,
	presentMarketingNotice,
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
			'Owlat paused sending to Microsoft after a spike in bounces or complaints'
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
