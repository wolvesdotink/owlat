// @vitest-environment happy-dom
/**
 * The full-page composer (pages/dashboard/compose.vue), which replaced the
 * floating popup in the corner. It has to seed the composer from whatever
 * opened it (a parked seed, a saved draft, a plain prefill), name the draft in
 * its URL only once the text it was opened with is saved (so a reload or a
 * Back never lands on an older copy of the row), key itself per compose
 * request (so a second open remounts the editor), and go back to the page it
 * came from after a send or a discard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import ComposePage from '../compose.vue';
import { composePageKey } from '~/composables/postbox/usePostboxComposeNav';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const keyboardInset = ref(0);
vi.mock('~/composables/useKeyboardInset', () => ({ useKeyboardInset: () => keyboardInset }));

let flushResult: { ok: boolean; result?: string };
const flush = vi.fn(async () => flushResult);
let rowId: string | null;
const snapshot = vi.fn(() => ({ draftId: rowId }));
const mirrorNow = vi.fn();

const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: {
		seed: { type: Object, required: true },
		frame: { type: String, default: undefined },
		replyAllRecipients: { type: Array, default: undefined },
	},
	emits: ['sent', 'discarded', 'draft-id', 'saved', 'subject', 'minimize'],
	setup(_props, { expose }) {
		expose({ flush, snapshot, mirrorNow });
	},
	template: '<div data-testid="composer" />',
});

let query: Record<string, string>;
let pageMeta: { key?: (route: { query: Record<string, unknown> }) => string } = {};
const replace = vi.fn(async () => {});
const back = vi.fn();
const navigate = vi.fn(async () => {});
const forget = vi.fn();
const bindDraft = vi.fn();
const parked: Record<string, unknown> = {};

beforeEach(() => {
	query = {};
	keyboardInset.value = 0;
	for (const key of Object.keys(parked)) delete parked[key];
	flushResult = { ok: true, result: 'draft-1' };
	flush.mockReset();
	flush.mockImplementation(async () => flushResult);
	rowId = null;
	mirrorNow.mockClear();
	bindDraft.mockClear();
	replace.mockClear();
	back.mockClear();
	navigate.mockClear();
	forget.mockClear();
	window.history.replaceState({ back: '/dashboard/postbox/inbox' }, '');
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', (meta: typeof pageMeta) => {
		pageMeta = meta;
	});
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useRoute', () => ({ query }));
	vi.stubGlobal('useRouter', () => ({
		replace,
		back,
		currentRoute: {
			get value() {
				return { query };
			},
		},
	}));
	vi.stubGlobal('usePostboxMailbox', () => ({
		currentMailbox: ref({ _id: 'mbx-1' }),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxComposeNav', () => ({
		seedFor: (key: string) => parked[key] ?? null,
		forget,
		bindDraft,
	}));
});

function mountPage() {
	return mount(ComposePage, {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposer: ComposerStub },
			stubs: { Icon: true, UiSkeleton: true },
		},
	});
}

const composer = (wrapper: ReturnType<typeof mountPage>) => wrapper.getComponent(ComposerStub);

describe('compose page — seeding', () => {
	it('opens a new message on the current mailbox in the page frame', () => {
		const c = composer(mountPage());
		expect(c.props('frame')).toBe('page');
		expect(c.props('seed')).toMatchObject({ mailboxId: 'mbx-1' });
	});

	it('takes the seed parked for its compose request', () => {
		parked['k1'] = {
			mailboxId: 'mbx-2',
			prefillTo: ['jonas@example.com'],
			prefillSubject: 'Fwd: Q3',
		};
		query = { c: 'k1' };
		expect(composer(mountPage()).props('seed')).toEqual(parked['k1']);
	});

	it('reopens a saved draft named in the URL', () => {
		query = { c: 'k2', mailbox: 'mbx-3', draft: 'draft-9' };
		expect(composer(mountPage()).props('seed')).toEqual({
			mailboxId: 'mbx-3',
			draftId: 'draft-9',
		});
	});

	it('prefills recipients and subject from a plain link', () => {
		query = { to: 'ada@example.com, bob@example.com', subject: 'Hi' };
		expect(composer(mountPage()).props('seed')).toMatchObject({
			mailboxId: 'mbx-1',
			prefillTo: ['ada@example.com', 'bob@example.com'],
			prefillSubject: 'Hi',
		});
	});
});

describe('compose page — naming the draft in the URL', () => {
	it('keeps an offline undo’s text in the URL until a save confirms it', async () => {
		// An offline undo hands back an existing draft id WITH newer, unsaved
		// text. The id arrives at once; naming it then would make a reload or a
		// Back load the older row and lose that text.
		parked['k3'] = {
			mailboxId: 'mbx-1',
			draftId: 'draft-7',
			prefillSubject: 'Edited offline',
			prefillBodyHtml: '<p>Newer text</p>',
		};
		query = { c: 'k3' };
		flushResult = { ok: false };
		const wrapper = mountPage();

		composer(wrapper).vm.$emit('draft-id', 'draft-7');
		await flushPromises();
		expect(flush).toHaveBeenCalledOnce();
		expect(replace).not.toHaveBeenCalled();
		expect(forget).not.toHaveBeenCalled();

		flushResult = { ok: true, result: 'draft-7' };
		composer(wrapper).vm.$emit('saved');
		await flushPromises();
		expect(forget).toHaveBeenCalledWith('k3');
		expect(replace).toHaveBeenCalledWith({
			query: { c: 'k3', mailbox: 'mbx-1', draft: 'draft-7' },
		});
	});

	it('names a new draft once its first save confirms it', async () => {
		query = { c: 'k4' };
		parked['k4'] = { mailboxId: 'mbx-1' };
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-1');
		await flushPromises();
		expect(replace).toHaveBeenCalledWith({
			query: { c: 'k4', mailbox: 'mbx-1', draft: 'draft-1' },
		});
	});

	it('leaves the URL alone for a draft it already names', async () => {
		query = { c: 'k5', mailbox: 'mbx-1', draft: 'draft-9' };
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-9');
		await nextTick();
		expect(replace).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});
});

describe('compose page — one instance per compose request', () => {
	it('keys the page on the request, which its own URL rewrite keeps', () => {
		mountPage();
		const key = pageMeta.key!;
		expect(key({ query: { c: 'a' } })).toBe(composePageKey('a'));
		// A second open (Undo of message A while B is on screen) remounts.
		expect(key({ query: { c: 'a' } })).not.toBe(key({ query: { c: 'b' } }));
		// Naming the draft after a save does not.
		expect(key({ query: { c: 'a', mailbox: 'mbx-1', draft: 'draft-1' } })).toBe(
			key({ query: { c: 'a' } })
		);
	});
});

describe('compose page — leaving', () => {
	it('goes back to the page it came from after a send or a discard', () => {
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('sent', { scheduled: false });
		composer(wrapper).vm.$emit('discarded');
		expect(back).toHaveBeenCalledTimes(2);
	});

	it('lands on the inbox when it was opened directly', () => {
		window.history.replaceState({}, '');
		composer(mountPage()).vm.$emit('sent', { scheduled: false });
		expect(back).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});
});

describe('compose page — on-screen keyboard', () => {
	it('leaves the keyboard out of the frame, so Send stays above it', async () => {
		const wrapper = mountPage();
		const frame = () => wrapper.get('[data-testid="compose-page"]').attributes('style') ?? '';
		expect(frame()).toContain('--compose-keyboard-inset: 0px');

		keyboardInset.value = 320;
		await nextTick();
		expect(frame()).toContain('--compose-keyboard-inset: 320px');
		// The home indicator sits under the keyboard while one is open.
		expect(frame()).toContain('--compose-bottom-inset: 0px');
	});
});

describe('compose page — leaving before the text is confirmed saved', () => {
	const offlineUndo = () => {
		parked['k6'] = {
			mailboxId: 'mbx-1',
			draftId: 'draft-7',
			prefillSubject: 'Edited offline',
		};
		query = { c: 'k6' };
	};

	it('binds the request to its row and mirrors the screen; nothing runs after', async () => {
		offlineUndo();
		flushResult = { ok: false };
		rowId = 'draft-7';
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-7');
		await flushPromises();
		flush.mockClear();

		wrapper.unmount();
		// A return opens the row, never the older seed; the mirror offers back
		// whatever the server never received.
		expect(mirrorNow).toHaveBeenCalledOnce();
		expect(bindDraft).toHaveBeenCalledWith('k6', 'mbx-1', 'draft-7');
		// No save of its own is started on the way out, so none can land later
		// and overwrite anything (the composer's own debounced save still runs).
		await flushPromises();
		expect(flush).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});

	it('keeps the seed when the text never got a row: it is the only copy', () => {
		parked['k7'] = { mailboxId: 'mbx-1', prefillSubject: 'Typed offline' };
		query = { c: 'k7' };
		rowId = null;
		mountPage().unmount();
		expect(bindDraft).not.toHaveBeenCalled();
		expect(forget).not.toHaveBeenCalled();
		expect(mirrorNow).not.toHaveBeenCalled();
	});

	it('settles nothing for a request already bound to its row', () => {
		// A return to a bound request, left again before the row loaded: its
		// empty placeholders are not text, and must not be parked as such.
		parked['k8'] = { mailboxId: 'mbx-1', draftId: 'draft-7' };
		query = { c: 'k8' };
		rowId = 'draft-7';
		mountPage().unmount();
		expect(bindDraft).not.toHaveBeenCalled();
		expect(mirrorNow).not.toHaveBeenCalled();
	});

	it('never rewrites the URL for a save that lands after the page closed', async () => {
		offlineUndo();
		let land: (value: { ok: boolean; result?: string }) => void = () => {};
		flush.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-7');
		await nextTick();

		// The user opens composer B meanwhile; A's save lands afterwards.
		query = { c: 'other' };
		wrapper.unmount();
		land({ ok: true, result: 'draft-7' });
		await flushPromises();
		expect(replace).not.toHaveBeenCalled();
	});

	it('settles nothing after a send or a discard, and forgets the seed', async () => {
		offlineUndo();
		rowId = 'draft-7';
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('sent', { scheduled: false });
		wrapper.unmount();
		await flushPromises();
		expect(forget).toHaveBeenCalledWith('k6');
		expect(bindDraft).not.toHaveBeenCalled();
		expect(mirrorNow).not.toHaveBeenCalled();
	});

	it('confirms again when a save lands while an earlier confirmation runs', async () => {
		offlineUndo();
		let land: (value: { ok: boolean; result?: string }) => void = () => {};
		flush.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-7');
		await nextTick();
		composer(wrapper).vm.$emit('saved');
		land({ ok: false });
		flushResult = { ok: true, result: 'draft-7' };
		await flushPromises();
		expect(flush).toHaveBeenCalledTimes(2);
		expect(replace).toHaveBeenCalledWith({
			query: { c: 'k6', mailbox: 'mbx-1', draft: 'draft-7' },
		});
	});
});
