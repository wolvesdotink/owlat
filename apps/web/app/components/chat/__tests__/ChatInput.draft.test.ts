// @vitest-environment happy-dom
/**
 * A chat room's unsent message survives a reload, and the sidebar marks the
 * room with a pencil while it waits.
 *
 * Each "page" re-imports the app modules over the same device store, so
 * nothing but the store carries over, as after a real reload. Sending keeps
 * the acknowledgement contract: a refused send keeps text and files on the
 * device, an accepted one takes away only what was sent.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { composerDraftKey } from '~/utils/composerDraftStore';

const device = vi.hoisted(() => ({ driver: null as unknown }));
vi.mock('~/utils/postboxOfflineKvDriver', () => ({ getOfflineKvDriver: () => device.driver }));

let nextUploadId = 0;
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useChatMentionSearch: () => ({ candidates: ref([]) }),
		useChatAttachments: () => ({
			isUploading: ref(false),
			uploadFile: async () => `asset_${++nextUploadId}`,
		}),
	});
});

beforeEach(async () => {
	const { composerDraftTestDriver } = await import('~/utils/__tests__/composerDraftTestDriver');
	device.driver = composerDraftTestDriver();
	nextUploadId = 0;
});

/** A fresh page: new modules, a new book, the same device store. */
async function openPage(userId = 'u1') {
	vi.resetModules();
	const drafts = await import('~/composables/useComposerDrafts');
	const ChatInput = (await import('../ChatInput.vue')).default;
	const ChatSidebar = (await import('../ChatSidebar.vue')).default;
	const book = drafts.useComposerDrafts();
	book.bindUser(userId);
	await book.idle();
	const global = {
		plugins: [createTestI18n()],
		stubs: {
			ChatMentionPicker: true,
			UiSpinner: true,
			UiAvatar: true,
			UiSkeleton: true,
			Icon: true,
		},
	};
	const send = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
	const input = (room: string) =>
		mount(ChatInput, { props: { send: send as never, draftTarget: room }, global });
	const room = (id: string, name: string) => ({
		_id: id,
		kind: 'channel' as const,
		displayName: name,
		visibility: 'public' as const,
		lastMessageAt: 0,
		avatarSeed: name,
		unread: { unreadCount: 0, hasMention: false },
	});
	const sidebar = () =>
		mount(ChatSidebar, {
			props: {
				channels: [room('room1', 'launches'), room('room2', 'general')] as never,
				dms: [],
				isLoading: false,
			},
			global,
		});
	return { book, send, input, sidebar };
}

async function attach(w: VueWrapper, name: string) {
	const field = w.get('input[type="file"]');
	Object.defineProperty(field.element, 'files', {
		configurable: true,
		value: [new File(['x'], name, { type: 'text/plain' })],
	});
	await field.trigger('change');
	await flushPromises();
}

const chips = (w: VueWrapper) =>
	w.findAll('button[aria-label^="Remove"]').map((b) => b.attributes('aria-label'));

describe('ChatInput drafts', () => {
	it('brings back the text and files after a reload, and marks the room', async () => {
		const first = await openPage();
		const w = first.input('room1');
		await w.get('textarea').setValue('launch copy is ready');
		await attach(w, 'brief.pdf');
		await first.book.idle();

		const reload = await openPage();
		const again = reload.input('room1');
		expect((again.get('textarea').element as HTMLTextAreaElement).value).toBe(
			'launch copy is ready'
		);
		expect(chips(again)).toEqual(['Remove attachment brief.pdf']);
		expect(reload.input('room2').get('textarea').element.value).toBe('');

		const rows = reload
			.sidebar()
			.findAll('button')
			.filter((b) => b.text().includes('launches'));
		expect(rows[0]!.find('[data-testid="draft-marker"]').exists()).toBe(true);
		const general = reload
			.sidebar()
			.findAll('button')
			.filter((b) => b.text().includes('general'));
		expect(general[0]!.find('[data-testid="draft-marker"]').exists()).toBe(false);
	});

	it('never offers one person’s draft to the next', async () => {
		const first = await openPage('u1');
		await first.input('room1').get('textarea').setValue('private words');
		await first.book.idle();

		const other = await openPage('u2');
		expect(other.input('room1').get('textarea').element.value).toBe('');
	});

	it('keeps a refused send on the device and clears it once a send is accepted', async () => {
		const first = await openPage();
		first.send.mockResolvedValueOnce({ ok: false });
		const w = first.input('room1');
		await w.get('textarea').setValue('try again');
		await w.get('textarea').trigger('keydown', { key: 'Enter' });
		await flushPromises();
		await first.book.idle();
		const key = composerDraftKey('u1', 'chat', 'room1');
		const driver = device.driver as { map: Map<string, unknown> };
		expect(driver.map.get(key)).toMatchObject({ fields: { text: 'try again' } });

		await w.get('textarea').trigger('keydown', { key: 'Enter' });
		await flushPromises();
		await first.book.idle();
		expect(driver.map.has(key)).toBe(false);

		const reload = await openPage();
		expect(reload.input('room1').get('textarea').element.value).toBe('');
	});
});
