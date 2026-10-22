/**
 * "To do, no reply needed": one row per thread with its first item, and when
 * the band could not list everything it says so instead of dropping rows.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { mail: { interpret: { todo: { listNoReplyToDo: 'todo' } } } },
}));
const data = ref<unknown>(undefined);
// The viewer's "Show the brief above conversations", and the mailbox's scope.
const isBriefShown = ref(true);
const scope = ref<'personal' | 'shared'>('personal');
beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxSettings', () => ({ autoSummarize: isBriefShown }));
	vi.stubGlobal('useInboxes', () => ({
		byId: computed(() => new Map([['mb1', { scope: scope.value }]])),
	}));
	vi.stubGlobal('useConvexQuery', () => ({ data, isLoading: ref(false) }));
});

const { default: TodayToDo } = await import('../TodayToDo.vue');

const row = {
	threadId: 't1',
	messageId: 'm1',
	itemId: 'i1',
	text: { en: 'Pay invoice 2026-10, €38.08', de: 'Zahle die Rechnung' },
	dueAt: Date.UTC(2026, 9, 21),
	count: 3,
	fromAddress: 'billing@example.com',
	fromName: 'Hetzner Online',
	subject: 'Invoice 2026-10',
	lastMessageAt: 1,
};

function mountBand() {
	return mount(TodayToDo, {
		props: { mailboxId: 'mb1' },
		global: {
			plugins: [createTestI18n()],
			stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } },
		},
	});
}

describe('TodayToDo', () => {
	it('lists each thread with its first item, opening it on the Overview', () => {
		data.value = { rows: [row], isTruncated: false };
		const w = mountBand();
		expect(w.text()).toContain('To do, no reply needed · 1');
		expect(w.text()).toContain('Pay invoice 2026-10, €38.08');
		expect(w.text()).toContain('+2 more');
		expect(w.text()).toContain('Hetzner Online · Invoice 2026-10');
		expect(w.get('a').attributes('href')).toBe(
			'/dashboard/postbox/inbox/m1?mailbox=mb1&view=overview'
		);
		expect(w.find('[data-testid="today-todo-more"]').exists()).toBe(false);
	});

	it('says when there is more than it lists', () => {
		data.value = { rows: [row], isTruncated: true };
		const w = mountBand();
		expect(w.get('[data-testid="today-todo-more"]').text()).toContain(
			'There is more to do in this inbox.'
		);
		expect(w.text()).toContain('+2 more');
	});

	it('keeps the truncation notice when no row could be listed', () => {
		data.value = { rows: [], isTruncated: true };
		const w = mountBand();
		expect(w.find('[data-testid="today-todo"]').exists()).toBe(true);
		expect(w.text()).toContain('To do, no reply needed');
		expect(w.text()).not.toContain('· 0');
		expect(w.get('[data-testid="today-todo-more"]').text()).toContain(
			'There is more to do in this inbox.'
		);
	});

	it('renders nothing with nothing to do', () => {
		data.value = { rows: [], isTruncated: false };
		expect(mountBand().find('[data-testid="today-todo"]').exists()).toBe(false);
	});

	it('shows a personal row as its subject and sender, without AI wording or chip, with the brief off', () => {
		data.value = { rows: [row], isTruncated: false };
		isBriefShown.value = false;
		try {
			const w = mountBand();
			expect(w.text()).toContain('Invoice 2026-10');
			expect(w.text()).toContain('Hetzner Online');
			expect(w.text()).not.toContain('Pay invoice');
			expect(w.text()).not.toContain('+2 more');
			// A shared mailbox's rows are the team's actions and stay.
			scope.value = 'shared';
			const shared = mountBand();
			expect(shared.text()).toContain('Pay invoice 2026-10, €38.08');
			expect(shared.text()).toContain('+2 more');
		} finally {
			isBriefShown.value = true;
			scope.value = 'personal';
		}
	});
});
