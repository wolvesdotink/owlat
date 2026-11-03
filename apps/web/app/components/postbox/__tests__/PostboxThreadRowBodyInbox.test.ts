/**
 * A row in a list that spans mailboxes (All inboxes) names the inbox it came
 * from; a row in one mailbox's folder carries no chip.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';
import PostboxRowCore from '../PostboxRowCore.vue';
import PostboxUnreadMark from '../PostboxUnreadMark.vue';
import { providePostboxRowInbox } from '~/composables/postbox/usePostboxRowInbox';
import type { InboxIdentity } from '~/utils/inboxIdentity';

vi.mock('~/composables/postbox/usePostboxListClock', () => ({
	usePostboxThreadTimestamp: () => () => '09:12',
}));
vi.mock('~/composables/useLocalized', () => ({ useLocalized: () => (text: string) => text }));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const support: InboxIdentity = {
	mailboxId: 'mb_support',
	name: 'Support',
	address: 'support@owlat.test',
	scope: 'shared',
	slot: 1,
	unread: 0,
};

const msg = {
	_id: 'm1',
	mailboxId: 'mb_support',
	fromAddress: 'ben@example.com',
	subject: 'Invoice #2041',
	snippet: 'Attached',
	receivedAt: Date.UTC(2026, 9, 17, 9),
	flagSeen: true,
	flagFlagged: false,
};

function mountRow(lookup: InboxIdentity[] | null) {
	const Host = defineComponent({
		setup() {
			if (lookup) providePostboxRowInbox(ref(new Map(lookup.map((i) => [i.mailboxId, i]))));
			return () => h(PostboxThreadRowBody, { msg: msg as never });
		},
	});
	return mount(Host, {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxRowCore, PostboxUnreadMark },
			stubs: { PostboxThreadRowFollowUp: true, Icon: true },
		},
	});
}

describe('PostboxThreadRowBody inbox chip', () => {
	it('names the inbox a row came from in a list that spans mailboxes', () => {
		expect(mountRow([support]).get('[data-testid="row-inbox-chip"]').text()).toBe('Support');
	});

	it('shows no chip in one mailbox, or for a row whose inbox the list does not know', () => {
		expect(mountRow(null).find('[data-testid="row-inbox-chip"]').exists()).toBe(false);
		expect(mountRow([]).find('[data-testid="row-inbox-chip"]').exists()).toBe(false);
	});
});
