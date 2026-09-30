// @vitest-environment happy-dom
/**
 * The contact page's channel timeline and a large Team Inbox email (#900):
 * such a message is mirrored as its excerpt, so the row says it is shortened
 * and links to the thread where the whole message is read. A whole email says
 * nothing extra.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount, RouterLinkStub } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('~/composables/useChannelOutbound', () => ({
	useChannelOutbound: () => ({
		isAdmin: ref(false),
		enabledProviderChannels: ref([]),
		isSending: ref(false),
		send: vi.fn(),
	}),
}));

const rows = ref<Array<Record<string, unknown>>>([]);
vi.stubGlobal('useUnifiedContactTimeline', () => ({
	filteredTimeline: rows,
	latestThreadId: ref(null),
	isLoading: ref(false),
	channelFilter: ref(null),
	channels: ref(['email']),
	channelIcon: () => 'lucide:mail',
	channelLabel: (channel: string) => channel,
	channelColor: () => '',
	directionIcon: () => 'lucide:arrow-down-left',
	formatTime: () => 'today',
	truncate: (text: string) => text,
}));

const UnifiedTimelineTab = (await import('../UnifiedTimelineTab.vue')).default;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function email(over: Record<string, unknown>) {
	return {
		_id: 'um_1',
		channel: 'email',
		direction: 'inbound',
		status: 'received',
		threadId: 'thread_1',
		createdAt: 0,
		...over,
	};
}

function mountTab() {
	return mount(UnifiedTimelineTab, {
		props: { contactId: 'ct_1' as never },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiBadge: true,
				UiSpinner: true,
				UiIconBox: true,
				UiSelect: true,
				UiTextarea: true,
				UiButton: true,
				NuxtLink: RouterLinkStub,
			},
		},
	});
}

describe('UnifiedTimelineTab', () => {
	it('marks a shortened email and links to its thread', () => {
		rows.value = [
			email({
				content: {
					text: 'The opening of a newsletter',
					subject: 'News',
					isBodyTruncated: true,
					inboundMessageId: 'in_1',
				},
			}),
		];
		const wrapper = mountTab();
		expect(wrapper.text()).toContain('Shortened: this is the beginning of a long email.');
		const link = wrapper.findComponent(RouterLinkStub);
		expect(link.props('to')).toBe('/dashboard/inbox/thread_1');
		expect(link.text()).toBe('Open the full message');
	});

	it('says nothing extra about a whole email', () => {
		rows.value = [email({ content: { text: 'A short email', subject: 'Hi' } })];
		const wrapper = mountTab();
		expect(wrapper.text()).toContain('A short email');
		expect(wrapper.text()).not.toContain('Shortened');
		expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false);
	});
});
