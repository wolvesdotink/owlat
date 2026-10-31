/**
 * The Workbench names an inbox's address and where its name leads in a
 * UiTooltip, which keyboard focus opens too; a native title never showed on
 * focus, and arrow keys move focus along the tab row.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import TodayScopeHeader from '../TodayScopeHeader.vue';
import TodayWorkbenchTabs from '../TodayWorkbenchTabs.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip, tooltipOf } from '~/__tests__/tooltip';
import type { WorkbenchTab } from '~/utils/workbench';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const tabs: WorkbenchTab[] = [
	{
		scope: 'mb_ada' as WorkbenchTab['scope'],
		name: 'Ada',
		slot: 0,
		address: 'ada@owlat.example',
		isTeam: false,
		answer: 2,
		unread: 0,
	},
	{
		scope: 'team' as WorkbenchTab['scope'],
		name: 'Team inbox',
		slot: null,
		address: null,
		isTeam: true,
		answer: 0,
		unread: 1,
	},
];

describe('Workbench tooltips', () => {
	it("shows an inbox tab's address on focus, and nothing for the team inbox", async () => {
		const w = mount(TodayWorkbenchTabs, {
			props: { tabs, selected: tabs[0]!.scope },
			attachTo: document.body,
			global: { plugins: [createTestI18n()], stubs: { Icon: true } },
		});
		const [inbox, team] = w.findAll('[role="tab"]');
		expect(inbox!.attributes('title')).toBeUndefined();
		expect(await focusTooltip(inbox!)).toBe('ada@owlat.example');
		expect(tooltipOf(w, team!)).toBeUndefined();
		expect(await focusTooltip(team!)).toBeNull();
		w.unmount();
	});

	it("says the scope's name opens its inbox, in a tooltip", () => {
		const w = mount(TodayScopeHeader, {
			props: {
				name: 'Ada',
				slot: 0,
				address: 'ada@owlat.example',
				kind: 'personal',
				sinceLabel: 'In the last 24 hours',
				isLoading: false,
				stats: { newMail: 0, isNewMailCapped: false, important: 0, moved: 0, filed: 0 },
				canMarkSeen: false,
				inboxHref: '/dashboard/postbox/inbox?mailbox=mb_ada',
				composeHref: null,
			},
			global: {
				plugins: [createTestI18n()],
				stubs: {
					Icon: true,
					NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
					UiDropdownMenu: true,
					UiDropdownMenuItem: true,
					UiSkeleton: true,
				},
			},
		});
		const link = w.get('#workbench-scope-name a');
		expect(link.attributes('title')).toBeUndefined();
		expect(tooltipOf(w, link)).toBe('Open inbox');
	});
});
