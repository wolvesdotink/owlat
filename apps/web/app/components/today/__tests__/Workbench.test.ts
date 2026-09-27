// @vitest-environment happy-dom
/**
 * The Workbench's own pieces, mounted against the real `en` catalog:
 *   - the tab row is an ARIA tablist; ←/→ select the neighbour, and a tab
 *     says what waits there (answers first, else unread);
 *   - "Filed away" shows one tile per kind with its count and a few senders,
 *     each opening that exact list in this inbox, and nothing for empty kinds;
 *   - the scope header names the inbox and jumps to its bands;
 *   - none of the three has axe violations.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TodayWorkbenchTabs from '../TodayWorkbenchTabs.vue';
import TodayFiledAway from '../TodayFiledAway.vue';
import TodayScopeHeader from '../TodayScopeHeader.vue';
import { auditA11y } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { WorkbenchTab } from '~/utils/workbench';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const TABS: WorkbenchTab[] = [
	{
		scope: 'mb_me',
		name: 'Marcel',
		slot: 0,
		address: 'marcel@owlat.example',
		isTeam: false,
		answer: 2,
		unread: 6,
	},
	{
		scope: 'mb_support',
		name: 'Support',
		slot: 1,
		address: 'support@owlat.example',
		isTeam: false,
		answer: 0,
		unread: 11,
	},
	{
		scope: 'team',
		name: 'Team inbox',
		slot: null,
		address: null,
		isTeam: true,
		answer: 0,
		unread: 0,
	},
];

const stubs = { Icon: true, NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } };

describe('TodayWorkbenchTabs', () => {
	it('marks the open tab and says what waits in each', () => {
		const w = mount(TodayWorkbenchTabs, {
			props: { tabs: TABS, selected: 'mb_me' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const tabs = w.findAll('[role="tab"]');
		expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
		expect(tabs[0]!.attributes('tabindex')).toBe('0');
		expect(tabs[0]!.find('[aria-label]').attributes('aria-label')).toBe('2 need an answer');
		expect(tabs[1]!.find('[aria-label]').attributes('aria-label')).toBe('11 unread');
	});

	it('selects the neighbour with the arrow keys and clicks', async () => {
		const w = mount(TodayWorkbenchTabs, {
			props: { tabs: TABS, selected: 'mb_support' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const list = w.find('[role="tablist"]');
		await list.trigger('keydown', { key: 'ArrowRight' });
		await list.trigger('keydown', { key: 'Home' });
		await w.findAll('[role="tab"]')[2]!.trigger('click');
		expect(w.emitted('select')).toEqual([['team'], ['mb_me'], ['team']]);
	});

	it('has no axe violations', async () => {
		const violations = await auditA11y(TodayWorkbenchTabs, {
			props: { tabs: TABS, selected: 'mb_me' },
			global: { plugins: [createTestI18n()] },
		});
		expect(violations).toEqual([]);
	});
});

const MODEL = {
	filed: { newsletter: 12, notification: 2, receipt: 0, promotion: 0, spam: 1 },
	filedSenders: {
		newsletter: ['The Verge', 'Stratechery', 'Platformer'],
		notification: ['GitHub', 'Linear'],
		receipt: [],
		promotion: [],
		spam: [],
	},
	filedTotal: 15,
};

describe('TodayFiledAway', () => {
	it('counts each kind, names a few senders and links to that list', () => {
		const w = mount(TodayFiledAway, {
			props: { model: MODEL, scope: 'mb_me' },
			global: { plugins: [createTestI18n()], stubs },
		});
		const tiles = w.findAll('[data-filed-kind]');
		expect(tiles.map((tile) => tile.attributes('data-filed-kind'))).toEqual([
			'newsletter',
			'notification',
			'spam',
		]);
		expect(tiles[0]!.text()).toContain('12');
		expect(tiles[0]!.text()).toContain('newsletters');
		expect(tiles[0]!.text()).toContain('From The Verge, Stratechery, Platformer and others');
		expect(tiles[1]!.text()).toContain('From GitHub, Linear');
		expect(tiles[1]!.text()).not.toContain('and others');
		expect(tiles[0]!.attributes('href')).toBe('/dashboard/inboxes?in=mb_me&category=newsletter');
	});

	it('says so when nothing was filed away', () => {
		const w = mount(TodayFiledAway, {
			props: {
				model: {
					...MODEL,
					filed: { newsletter: 0, notification: 0, receipt: 0, promotion: 0, spam: 0 },
					filedTotal: 0,
				},
				scope: 'mb_me',
			},
			global: { plugins: [createTestI18n()], stubs },
		});
		expect(w.text()).toContain('Nothing filed away since you last looked.');
	});

	it('has no axe violations', async () => {
		const violations = await auditA11y(TodayFiledAway, {
			props: { model: MODEL, scope: 'mb_me' },
			global: { plugins: [createTestI18n()] },
		});
		expect(violations).toEqual([]);
	});
});

describe('TodayScopeHeader', () => {
	const props = {
		name: 'Support',
		slot: 1,
		address: 'support@owlat.example',
		kind: 'shared' as const,
		sinceLabel: 'Since you last looked (4:11 PM): 23 new emails.',
		isLoading: false,
		stats: { newMail: 23, isNewMailCapped: false, important: 3, moved: 2, filed: 15 },
		canMarkSeen: true,
		inboxHref: '/dashboard/postbox/inbox?mailbox=mb_support',
		composeHref: '/compose?mailbox=mb_support',
	};

	it('names the inbox and jumps from each number to its band', () => {
		const w = mount(TodayScopeHeader, {
			props,
			global: {
				plugins: [createTestI18n()],
				stubs: { ...stubs, UiButton: { template: '<button><slot /></button>' }, UiSkeleton: true },
			},
		});
		expect(w.find('h2').text()).toBe('Support');
		expect(w.text()).toContain('Shared inbox');
		const stats = w.findAll('[data-scope-stat]');
		expect(stats.map((s) => [s.attributes('data-scope-stat'), s.attributes('href')])).toEqual([
			['new', '#workbench-updates'],
			['important', '#workbench-updates'],
			['moved', '#workbench-changed'],
			['filed', '#workbench-filed'],
		]);
		expect(stats[0]!.text()).toBe('23new emails');
	});

	it('leaves "new email" and "moved" out on the team inbox', () => {
		const w = mount(TodayScopeHeader, {
			props: {
				...props,
				kind: 'team',
				address: null,
				stats: { ...props.stats, newMail: null, moved: null },
			},
			global: {
				plugins: [createTestI18n()],
				stubs: { ...stubs, UiButton: { template: '<button><slot /></button>' }, UiSkeleton: true },
			},
		});
		expect(w.findAll('[data-scope-stat]').map((s) => s.attributes('data-scope-stat'))).toEqual([
			'important',
			'filed',
		]);
	});

	it('has no axe violations', async () => {
		const violations = await auditA11y(TodayScopeHeader, {
			props,
			global: { plugins: [createTestI18n()] },
		});
		expect(violations).toEqual([]);
	});
});
