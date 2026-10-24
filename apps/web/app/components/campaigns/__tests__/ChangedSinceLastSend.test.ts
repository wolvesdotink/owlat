/**
 * The Review step's "changed since the last send" line. Three states, all of
 * them said out loud: never sent (or the send fell out of the history), sent
 * and unchanged, sent and changed. Comparing loads the last send's snapshot
 * and the template as stored, and drops an answer for a comparison already
 * closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ChangedSinceLastSend from '../ChangedSinceLastSend.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/email-builder', () => ({
	parseSnapshotBlocks: (content: string) => JSON.parse(content),
}));

const latest = ref<unknown>(undefined);
const queries: Array<{ args: Record<string, unknown> }> = [];
let answer: (args: Record<string, unknown>) => Promise<unknown>;
const toasts: string[] = [];

const SNAPSHOT = {
	_id: 'version1',
	createdAt: 1_700_000_000_000,
	content: '[{"id":"t1","type":"text","content":{"html":"Old"}}]',
	subject: 'Old subject',
	previewText: 'Old peek',
};
const TEMPLATE = {
	_id: 'template1',
	name: 'Spring launch',
	content: '[{"id":"t1","type":"text","content":{"html":"New"}}]',
	subject: 'New subject',
};

const compareStub = {
	props: ['open', 'before', 'after', 'loading'],
	emits: ['update:open'],
	template: `<div v-if="open" data-testid="compare">
		<span data-testid="before">{{ before ? before.subject + '|' + before.previewText + '|' + before.blocks[0].content.html : '' }}</span>
		<span data-testid="after">{{ after ? after.subject + '|' + after.previewText + '|' + after.blocks[0].content.html : '' }}</span>
		<button data-testid="close" @click="$emit('update:open', false)">close</button>
	</div>`,
};

function mountLine() {
	return mount(ChangedSinceLastSend, {
		props: { templateId: 'template1' as never },
		global: {
			plugins: [createTestI18n()],
			mocks: { formatRelativeTime: () => '3 days ago' },
			stubs: { EmailTemplateCompareModal: compareStub, Icon: true },
		},
	});
}

beforeEach(() => {
	latest.value = undefined;
	queries.length = 0;
	toasts.length = 0;
	answer = async (args) => ('versionId' in args ? SNAPSHOT : TEMPLATE);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	vi.stubGlobal('formatRelativeTime', () => '3 days ago');
	vi.stubGlobal('useOrganizationQuery', (_ref: unknown, args: () => Record<string, unknown>) => {
		queries.push({ args: args() });
		return { data: latest };
	});
	vi.stubGlobal('useConvex', () => ({
		query: (_ref: unknown, args: Record<string, unknown>) => answer(args),
	}));
});

describe('ChangedSinceLastSend', () => {
	it('asks about the template it is given, and shows nothing until it knows', () => {
		const wrapper = mountLine();
		expect(queries).toEqual([{ args: { templateId: 'template1' } }]);
		expect(wrapper.find('[data-testid="changed-since-last-send"]').exists()).toBe(false);
	});

	it('says when the history holds no earlier send', async () => {
		latest.value = null;
		const wrapper = mountLine();
		await flushPromises();
		expect(wrapper.text()).toContain('No earlier send of this email in its version history.');
		expect(wrapper.find('[data-testid="compare-last-send"]').exists()).toBe(false);
	});

	it('says when the email is unchanged since its last send', async () => {
		latest.value = { version: { _id: 'version1', createdAt: SNAPSHOT.createdAt }, unchanged: true };
		const wrapper = mountLine();
		await flushPromises();
		expect(wrapper.text()).toContain('Unchanged since the last send (3 days ago)');
		expect(wrapper.find('[data-testid="compare-last-send"]').exists()).toBe(false);
	});

	it('compares the last send with the template as stored', async () => {
		latest.value = {
			version: { _id: 'version1', createdAt: SNAPSHOT.createdAt },
			unchanged: false,
		};
		const wrapper = mountLine();
		await flushPromises();
		expect(wrapper.text()).toContain('Changed since the last send (3 days ago)');

		await wrapper.get('[data-testid="compare-last-send"]').trigger('click');
		await flushPromises();

		expect(wrapper.get('[data-testid="before"]').text()).toBe('Old subject|Old peek|Old');
		expect(wrapper.get('[data-testid="after"]').text()).toBe('New subject||New');
	});

	it('drops an answer that arrives after the comparison was closed', async () => {
		latest.value = {
			version: { _id: 'version1', createdAt: SNAPSHOT.createdAt },
			unchanged: false,
		};
		const settle: Array<() => void> = [];
		answer = (args) =>
			new Promise((resolve) =>
				settle.push(() => resolve('versionId' in args ? SNAPSHOT : TEMPLATE))
			);
		const wrapper = mountLine();
		await flushPromises();

		await wrapper.get('[data-testid="compare-last-send"]').trigger('click');
		await wrapper.get('[data-testid="close"]').trigger('click');
		for (const resolve of settle) resolve();
		await flushPromises();

		expect(wrapper.find('[data-testid="compare"]').exists()).toBe(false);
		await wrapper.get('[data-testid="compare-last-send"]').trigger('click');
		expect(wrapper.get('[data-testid="before"]').text()).toBe('');
	});

	it('closes with a message when the versions cannot be loaded', async () => {
		latest.value = {
			version: { _id: 'version1', createdAt: SNAPSHOT.createdAt },
			unchanged: false,
		};
		answer = async () => {
			throw new Error('offline');
		};
		const wrapper = mountLine();
		await flushPromises();

		await wrapper.get('[data-testid="compare-last-send"]').trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="compare"]').exists()).toBe(false);
		expect(toasts).toEqual(["Couldn't load the last send"]);
	});
});
