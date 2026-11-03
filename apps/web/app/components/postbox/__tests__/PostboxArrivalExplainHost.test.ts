/**
 * Read on arrival §4.1 wiring: the layout's host answers the web-reader seam
 * (`POSTBOX_WHY_HERE_KEY`), and a Priority row's hover bar opens "Why here?"
 * for its thread, anchored on the button; rows elsewhere have no such button.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadRow, { type PostboxThreadRowMessage } from '../PostboxThreadRow.vue';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import { BASE_MESSAGE } from './spoofedSenderFixture';
import { POSTBOX_PRIORITY_ROWS } from '~/utils/postboxPriorityGroups';
import { POSTBOX_WHY_HERE_KEY, usePostboxWhyHere } from '~/composables/postbox/usePostboxWhyHere';
import {
	destinationForPlacement,
	usePostboxArrivalExplainHost,
	usePostboxArrivalExplainState,
} from '~/composables/postbox/usePostboxArrivalExplain';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

describe('usePostboxArrivalExplainHost', () => {
	it('answers the reader seam and shares the state with what renders it', () => {
		let opener: ReturnType<typeof usePostboxWhyHere> | undefined;
		let state: ReturnType<typeof usePostboxArrivalExplainState> | undefined;
		const Child = defineComponent({
			setup() {
				opener = usePostboxWhyHere();
				state = usePostboxArrivalExplainState();
				return () => h('div');
			},
		});
		const Host = defineComponent({
			setup() {
				usePostboxArrivalExplainHost(computed(() => 'mb1' as never));
				return () => h(Child);
			},
		});
		mount(Host);
		opener!.open({ mailboxId: 'mb1', threadId: 't1', placement: 'digest', anchor: null });
		expect(state!.why.value).toMatchObject({ threadId: 't1', placement: 'digest' });
		expect(state!.mailboxId.value).toBe('mb1');
	});

	it('maps an archived placement to auto-archive for "Always here"', () => {
		expect(destinationForPlacement('archived')).toBe('auto_archive');
		expect(destinationForPlacement('updates')).toBe('updates');
	});
});

const open = vi.fn();

function mountRow(msg: Partial<PostboxThreadRowMessage>, isPriority: boolean) {
	return mount(PostboxThreadRow, {
		props: {
			msg: { ...BASE_MESSAGE, ...msg },
			folderRole: 'inbox',
			virtualize: false,
			selected: false,
			focused: false,
			active: false,
		},
		global: {
			plugins: [createTestI18n()],
			provide: {
				[POSTBOX_WHY_HERE_KEY as symbol]: { open },
				...(isPriority ? { [POSTBOX_PRIORITY_ROWS as symbol]: true } : {}),
			},
			components: {
				PostboxRowCore,
				PostboxThreadRowBody,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiContextMenu: {
					props: ['items'],
					template: '<slot :on-contextmenu="() => {}" :on-keydown="() => {}" />',
				},
				UiAvatar: { template: '<span />' },
				PostboxThreadRowFollowUp: { template: '<span />' },
				PostboxSwipeTrack: { template: '<div />' },
			},
			mocks: { resolveComponent: () => 'a' },
		},
	});
}

describe('the Priority row "Why here?"', () => {
	const placed = { mailboxId: 'mb1', threadId: 't1', placement: 'updates' as const };

	it('opens the popover for the row thread, anchored on the button', async () => {
		const w = mountRow(placed, true);
		const button = w.get('[data-testid="row-why-here"]');
		expect(button.attributes('aria-label')).toBe('Why is this here?');
		await button.trigger('click');
		expect(open).toHaveBeenCalledWith({
			mailboxId: 'mb1',
			threadId: 't1',
			placement: 'updates',
			anchor: button.element,
		});
	});

	it('is not offered outside the Priority view or without a placement', () => {
		expect(mountRow(placed, false).find('[data-testid="row-why-here"]').exists()).toBe(false);
		expect(
			mountRow({ ...placed, placement: undefined }, true)
				.find('[data-testid="row-why-here"]')
				.exists()
		).toBe(false);
	});
});
