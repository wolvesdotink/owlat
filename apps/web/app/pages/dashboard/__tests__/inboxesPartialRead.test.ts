// @vitest-environment happy-dom
/**
 * All inboxes merges one thread read per inbox. When one of them fails and
 * the others loaded, the loaded rows stay and a notice names the inbox that is
 * missing, with a Try again that re-reads it (#1099). Before, the failed
 * inbox's threads disappeared without a word.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import InboxReadFailureNotice from '~/components/inbox/InboxReadFailureNotice.vue';

const salesRefetch = vi.fn();
const failure = new Error('[CONVEX Q(mail/mailbox/queries:listThreads)] Server Error');

const thread = {
	_id: 'thr_a',
	latestSubject: 'Quarterly numbers',
	latestFromAddress: 'ines@example.com',
	latestSnippet: 'Attached',
	lastMessageAt: 1,
	unreadCount: 0,
	latestMessageId: 'msg_a',
};

function install(query: Record<string, string> = {}) {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ query, params: {}, path: '/dashboard/inboxes' }),
		useInboxes: () => ({
			inboxes: ref([
				{ mailboxId: 'mbx_support', name: 'Support', slot: 0, unread: 0 },
				{ mailboxId: 'mbx_sales', name: 'Sales', slot: 1, unread: 0 },
			]),
			ids: ref(['mbx_support', 'mbx_sales']),
			byId: ref(
				new Map([
					['mbx_support', { mailboxId: 'mbx_support', name: 'Support', slot: 0 }],
					['mbx_sales', { mailboxId: 'mbx_sales', name: 'Sales', slot: 1 }],
				])
			),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useConvexQueryMap: () =>
			new Map([
				[
					'mbx_support',
					{
						data: ref({ threads: [thread] }),
						isLoading: ref(false),
						error: ref(null),
						refetch: vi.fn(),
					},
				],
				[
					'mbx_sales',
					{
						data: ref(undefined),
						isLoading: ref(false),
						error: ref(failure),
						refetch: salesRefetch,
					},
				],
			]),
		// The team inbox read is off for this viewer.
		useConvexQuery: () => ({
			data: ref(undefined),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}),
		useFeatureFlag: () => ({ isEnabled: () => false }),
	});
}

async function render() {
	const { default: Page } = await import('../inboxes.vue');
	return mount(Page, {
		global: {
			plugins: [createTestI18n()],
			components: { InboxReadFailureNotice },
			stubs: { InboxChip: true, ShellStatusPill: true, UiSkeleton: true },
			// A Nuxt auto-import the template calls.
			mocks: { formatCompactRelativeTime: () => '1m' },
		},
	});
}

afterEach(() => {
	salesRefetch.mockClear();
});

describe('All inboxes with one failed inbox (#1099)', () => {
	it('keeps the loaded rows and names the failed inbox, with Try again', async () => {
		install();
		const wrapper = await render();

		expect(wrapper.text()).toContain('Quarterly numbers');
		const notice = wrapper.find('[data-testid="inbox-read-failure-notice"]');
		expect(notice.text()).toContain("Couldn't load Sales");
		await notice.find('button').trigger('click');
		expect(salesRefetch).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('leaves the failure out while another inbox is picked', async () => {
		install({ in: 'mbx_support' });
		const wrapper = await render();

		expect(wrapper.text()).toContain('Quarterly numbers');
		expect(wrapper.find('[data-testid="inbox-read-failure-notice"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
