/**
 * The jump-back store, mounted the way pages use it: an open is recorded once
 * the record has a title, re-recorded when that title changes, kept per person
 * and organization in storage, and hidden from the list while any surface still
 * shows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	type PaletteObjectOpen,
	useCommandPaletteObjectRecents,
	useRecordPaletteObjectOpen,
} from '../useCommandPaletteObjectRecents';

const user = ref<{ id: string } | null>({ id: 'u1' });
const organization = ref<string | null>('o1');
const navigateTo = vi.fn();
const setActiveMailboxId = vi.fn();

beforeEach(() => {
	localStorage.clear();
	user.value = { id: 'u1' };
	organization.value = 'o1';
	navigateTo.mockClear();
	setActiveMailboxId.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useAuth: () => ({ user, activeOrganizationId: organization }),
		useRoute: () => ({ path: '/dashboard/campaigns/c1/edit' }),
		usePostboxActiveMailbox: () => ({ setActiveMailboxId }),
		navigateTo,
	});
});

const mounted: VueWrapper[] = [];
afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
});

function mountWith(setup: () => void): VueWrapper {
	const wrapper = mount(
		defineComponent({
			setup() {
				setup();
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	mounted.push(wrapper);
	return wrapper;
}

function palette() {
	let recents!: ReturnType<typeof useCommandPaletteObjectRecents>;
	mountWith(() => {
		recents = useCommandPaletteObjectRecents();
	});
	recents.load();
	return recents;
}

function stored(key = 'owlat_recent_objects:u1:o1') {
	return JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{ id: string; title: string }>;
}

describe('useRecordPaletteObjectOpen', () => {
	it('records nothing until the record has a title, then files it under the page path', async () => {
		const open = ref<PaletteObjectOpen | null>(null);
		mountWith(() => useRecordPaletteObjectOpen(() => open.value));
		expect(stored()).toEqual([]);

		open.value = { kind: 'campaign', id: 'c1', title: 'Spring launch' };
		await nextTick();
		expect(stored()).toMatchObject([
			{ kind: 'campaign', id: 'c1', title: 'Spring launch', href: '/dashboard/campaigns/c1/edit' },
		]);
	});

	it('re-records a rename, still as one entry', async () => {
		const title = ref('Draft');
		mountWith(() =>
			useRecordPaletteObjectOpen(() => ({ kind: 'campaign', id: 'c1', title: title.value }))
		);
		title.value = 'Spring launch';
		await nextTick();
		expect(stored().map((entry) => entry.title)).toEqual(['Spring launch']);
	});

	it('keeps each person’s and organization’s list apart', async () => {
		mountWith(() =>
			useRecordPaletteObjectOpen(() => ({ kind: 'contact', id: 'k1', title: 'Ada' }))
		);
		organization.value = 'o2';
		mountWith(() =>
			useRecordPaletteObjectOpen(() => ({ kind: 'contact', id: 'k2', title: 'Ines' }))
		);
		await nextTick();
		expect(stored().map((entry) => entry.id)).toEqual(['k1']);
		expect(stored('owlat_recent_objects:u1:o2').map((entry) => entry.id)).toEqual(['k2']);
	});

	it('records nothing while nobody is signed in', () => {
		user.value = null;
		mountWith(() =>
			useRecordPaletteObjectOpen(() => ({ kind: 'contact', id: 'k1', title: 'Ada' }))
		);
		expect(localStorage.length).toBe(0);
	});
});

describe('useCommandPaletteObjectRecents', () => {
	it('lists a record only once no surface shows it, newest first', async () => {
		const first = mountWith(() =>
			useRecordPaletteObjectOpen(() => ({ kind: 'campaign', id: 'c1', title: 'Spring launch' }))
		);
		const second = mountWith(() =>
			useRecordPaletteObjectOpen(() => ({ kind: 'contact', id: 'k1', title: 'Ada Marlow' }))
		);
		const recents = palette();
		expect(recents.jumpBackItems.value).toEqual([]);

		second.unmount();
		mounted.splice(mounted.indexOf(second), 1);
		expect(recents.jumpBackItems.value.map((item) => [item.label, item.subtitle])).toEqual([
			['Ada Marlow', 'Contact'],
		]);

		first.unmount();
		mounted.splice(mounted.indexOf(first), 1);
		expect(recents.jumpBackItems.value.map((item) => item.label)).toEqual([
			'Ada Marlow',
			'Spring launch',
		]);
	});

	it('reopens a conversation in its own mailbox', () => {
		localStorage.setItem(
			'owlat_recent_objects:u1:o1',
			JSON.stringify([
				{
					kind: 'conversation',
					id: 't1',
					messageId: 'm1',
					mailboxId: 'mb-team',
					title: 'Quarterly numbers',
					href: '/dashboard/postbox/inbox/m1',
					openedAt: 5,
				},
			])
		);
		const recents = palette();
		recents.jumpBackItems.value[0]!.run();
		expect(setActiveMailboxId).toHaveBeenCalledWith('mb-team');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/m1');
		expect(recents.recencyOf('m1')).toBe(5);
	});

	it('survives storage that throws', () => {
		const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('denied');
		});
		try {
			expect(palette().jumpBackItems.value).toEqual([]);
		} finally {
			getItem.mockRestore();
		}
	});
});
