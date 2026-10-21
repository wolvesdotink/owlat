// @vitest-environment happy-dom
/**
 * ShareWithMembers — an owner or admin shares a knowledge entry that migration
 * 0069 restricted with members again (#1372).
 *
 * What it must not get wrong:
 *  - the review. The admin is checking for private text a past merge folded
 *    in, so the dialog shows the complete content, every tag and every contact
 *    link (by name, a deleted contact said as such) before anything is shared;
 *  - the version. The review on screen is the one confirmed: when the entry
 *    changes underneath it, sharing waits until the admin looks at the new one;
 *  - the refusals. An entry whose source keeps it from members says why and
 *    cannot be confirmed; Cancel shares nothing; nothing subscribes until the
 *    dialog opens.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h, type Ref } from 'vue';
import { getFunctionName, type FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

import ShareWithMembers from '../ShareWithMembers.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

type Review = NonNullable<FunctionReturnType<typeof api.knowledge.sharing.getShareReview>>;

const ENTRY_ID = 'entry_1' as Id<'knowledgeEntries'>;

const review = (overrides: Partial<Review> = {}): Review => ({
	entryId: ENTRY_ID,
	title: 'Jonas prefers a call',
	content: 'Call Jonas before any scope change.\nThe renewal discount is still confidential.',
	tags: ['harborline', 'renewal-pricing'],
	contacts: [
		{
			contactId: 'contact_1' as Id<'contacts'>,
			name: 'Jonas Weber',
			email: 'jonas@example.com',
		},
		{ contactId: 'contact_2' as Id<'contacts'>, name: null, email: 'billing@example.com' },
		{ contactId: 'contact_3' as Id<'contacts'>, name: null, email: null },
	],
	blocker: null,
	fingerprint: 'fp-1',
	...overrides,
});

const live: Ref<Review | null | undefined> = ref(undefined);
let argsFactory: (() => unknown) | undefined;
const runs: { name: string; args: unknown }[] = [];
let runResult: { ok: boolean } = { ok: true };
const toasts: string[] = [];

beforeEach(() => {
	live.value = undefined;
	argsFactory = undefined;
	runs.length = 0;
	runResult = { ok: true };
	toasts.length = 0;
	vi.stubGlobal(
		'useOrganizationQuery',
		(reference: Parameters<typeof getFunctionName>[0], args: () => unknown) => {
			expect(getFunctionName(reference)).toBe(
				getFunctionName(api.knowledge.sharing.getShareReview)
			);
			argsFactory = args;
			return { data: live, isLoading: ref(false), error: ref(null) };
		}
	);
	vi.stubGlobal('useBackendOperation', (reference: Parameters<typeof getFunctionName>[0]) => ({
		run: async (args: unknown) => {
			runs.push({ name: getFunctionName(reference), args });
			return runResult.ok ? { ok: true, result: ENTRY_ID } : { ok: false };
		},
		isLoading: ref(false),
		inlineError: ref(null),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const modalStub = defineComponent({
	props: { open: Boolean, title: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			props.open
				? h('div', { 'data-testid': 'modal' }, [
						h('h2', props.title),
						slots.default?.(),
						slots.footer?.(),
					])
				: null,
});
const buttonStub = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup:
		(props, { slots, emit, attrs }) =>
		() =>
			h(
				'button',
				{ ...attrs, type: 'button', disabled: props.disabled, onClick: () => emit('click') },
				slots.default?.()
			),
});
const linkStub = defineComponent({
	props: { to: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			h('a', { href: props.to }, slots.default?.()),
});

const mountShare = () =>
	mount(ShareWithMembers, {
		props: { entryId: ENTRY_ID },
		global: {
			plugins: [createTestI18n()],
			stubs: { UiModal: modalStub, UiButton: buttonStub, NuxtLink: linkStub, Icon: true },
		},
	});

const buttonNamed = (wrapper: ReturnType<typeof mountShare>, name: string) => {
	const button = wrapper.findAll('button').find((b) => b.text() === name);
	if (!button) throw new Error(`no button "${name}"`);
	return button;
};

async function openReview(wrapper: ReturnType<typeof mountShare>, value: Review | null) {
	await buttonNamed(wrapper, 'Share with members').trigger('click');
	live.value = value;
	await flushPromises();
}

describe('ShareWithMembers', () => {
	it('subscribes to the review only while the dialog is open', async () => {
		const wrapper = mountShare();
		expect(argsFactory?.()).toBeUndefined();
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		await buttonNamed(wrapper, 'Share with members').trigger('click');
		expect(argsFactory?.()).toEqual({ entryId: ENTRY_ID });
		expect(wrapper.text()).toContain('Loading the entry…');
	});

	it('shows the complete entry and shares the reviewed version', async () => {
		const wrapper = mountShare();
		await openReview(wrapper, review());

		expect(wrapper.find('h2').text()).toBe('Share with members?');
		expect(wrapper.text()).toContain('Jonas prefers a call');
		expect(wrapper.find('[data-testid="share-content"]').text()).toBe(
			'Call Jonas before any scope change.\nThe renewal discount is still confidential.'
		);
		expect(wrapper.findAll('[data-testid="share-tag"]').map((tag) => tag.text())).toEqual([
			'harborline',
			'renewal-pricing',
		]);
		const contacts = wrapper.findAll('[data-testid="share-contact"]');
		expect(contacts.map((c) => c.findAll('a, span').map((part) => part.text()))).toEqual([
			['Jonas Weber', 'jonas@example.com'],
			['billing@example.com'],
			['Deleted contact'],
		]);
		expect(contacts[0]!.find('a').attributes('href')).toBe(
			'/dashboard/audience/contacts/contact_1'
		);
		expect(contacts[2]!.find('a').exists()).toBe(false);
		expectFullyLocalized(wrapper);

		const confirm = wrapper.find('[data-testid="share-confirm"]');
		expect(confirm.attributes('disabled')).toBeUndefined();
		await confirm.trigger('click');
		await flushPromises();

		expect(runs).toEqual([
			{
				name: getFunctionName(api.knowledge.sharing.shareWithMembers),
				args: { entryId: ENTRY_ID, fingerprint: 'fp-1' },
			},
		]);
		expect(toasts).toEqual(['Members can now see this entry.']);
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
	});

	it('shares nothing on Cancel', async () => {
		const wrapper = mountShare();
		await openReview(wrapper, review());
		await buttonNamed(wrapper, 'Cancel').trigger('click');
		await flushPromises();
		expect(runs).toEqual([]);
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
	});

	it('says why an entry cannot be shared and does not offer to', async () => {
		const wrapper = mountShare();
		await openReview(wrapper, review({ blocker: 'mail_capture' }));
		expect(wrapper.find('[data-testid="share-blocked"]').text()).toContain(
			'comes from a file captured from mail'
		);
		const confirm = wrapper.find('[data-testid="share-confirm"]');
		expect(confirm.attributes('disabled')).toBeDefined();
		await confirm.trigger('click');
		expect(runs).toEqual([]);
		expectFullyLocalized(wrapper);
	});

	it('holds the reviewed version and waits for a look at a changed entry', async () => {
		const wrapper = mountShare();
		await openReview(wrapper, review());

		live.value = review({
			content: 'Call Jonas first.\nAcme is acquiring Harborline.',
			fingerprint: 'fp-2',
		});
		await flushPromises();
		expect(wrapper.find('[data-testid="share-changed"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="share-content"]').text()).toContain(
			'The renewal discount is still confidential.'
		);
		expect(wrapper.find('[data-testid="share-confirm"]').attributes('disabled')).toBeDefined();

		await buttonNamed(wrapper, 'Review the new version').trigger('click');
		expect(wrapper.find('[data-testid="share-changed"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="share-content"]').text()).toContain(
			'Acme is acquiring Harborline.'
		);
		await wrapper.find('[data-testid="share-confirm"]').trigger('click');
		await flushPromises();
		expect(runs.map((r) => r.args)).toEqual([{ entryId: ENTRY_ID, fingerprint: 'fp-2' }]);
	});

	it('keeps the dialog open when the share is refused', async () => {
		runResult = { ok: false };
		const wrapper = mountShare();
		await openReview(wrapper, review());
		await wrapper.find('[data-testid="share-confirm"]').trigger('click');
		await flushPromises();
		expect(runs).toHaveLength(1);
		expect(toasts).toEqual([]);
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(true);
	});
});
