// @vitest-environment happy-dom
/**
 * The full-page composer (pages/dashboard/compose.vue), which replaced the
 * floating popup in the corner. Every composer it mounts belongs to a compose
 * request (`?c=`, usePostboxComposeNav): a plain link is given one before any
 * composer mounts, an unknown one says it has expired, and the composer is
 * seeded with the request's nonce so a remount reaches the same row. It names
 * the draft in its URL only once the text it was opened with is saved, keys
 * itself per request, parks unsaved text on every unfinished leave (and on
 * `pagehide`), and goes back to the page it came from after a send or discard.
 *
 * Runs against the real request record (session state + sessionStorage); the
 * composer is a stub exposing what the page uses of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';

import ComposePage from '../compose.vue';
import {
	composePageKey,
	usePostboxComposeNav,
	type ComposeSpec,
} from '~/composables/postbox/usePostboxComposeNav';
import type { ParkableSnapshot } from '~/composables/postbox/usePostboxComposeRow';
import { MIRROR_FIELD_NAMES, type MirrorFields } from '~/utils/postboxDraftMirror';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const keyboardInset = ref(0);
vi.mock('~/composables/useKeyboardInset', () => ({ useKeyboardInset: () => keyboardInset }));

function fields(overrides: Partial<MirrorFields> = {}): MirrorFields {
	return {
		toAddresses: [],
		ccAddresses: [],
		bccAddresses: [],
		subject: '',
		bodyHtml: '',
		bodyBlocks: '[]',
		composerMode: 'simple',
		followUpRemindAt: null,
		...overrides,
	};
}

let flushResult: { ok: boolean; result?: string | null };
const flush = vi.fn(async () => flushResult);
let snap: ParkableSnapshot;
const parkable = vi.fn(() => snap);
const mirrorNow = vi.fn(async () => true);
const rescanMirror = vi.fn(async () => {});
let createdListeners: ((id: string) => void)[];
const onCreated = vi.fn((listener: (id: string) => void) => {
	createdListeners.push(listener);
	return () => {};
});

const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: {
		seed: { type: Object, required: true },
		frame: { type: String, default: undefined },
		beforeReady: { type: Function, default: undefined },
		replyAllRecipients: { type: Array, default: undefined },
	},
	emits: ['sent', 'discarded', 'draft-id', 'saved', 'subject', 'minimize'],
	setup(_props, { expose }) {
		expose({ flush, parkable, mirrorNow, rescanMirror, onCreated });
	},
	template: '<div data-testid="composer" />',
});

let query: Record<string, string>;
let pageMeta: { key?: (route: { query: Record<string, unknown> }) => string } = {};
const replace = vi.fn(async (_to: unknown) => {});
const back = vi.fn();
const navigate = vi.fn(async (..._args: unknown[]) => {});
let states: Record<string, unknown>;
const currentMailbox = ref<{ _id: string } | null>({ _id: 'mbx-1' });

// A page left mounted keeps its window listeners (Esc, pagehide) for the next case.
enableAutoUnmount(afterEach);

beforeEach(() => {
	query = {};
	states = {};
	window.sessionStorage.clear();
	keyboardInset.value = 0;
	currentMailbox.value = { _id: 'mbx-1' };
	flushResult = { ok: true, result: 'draft-1' };
	flush.mockReset();
	flush.mockImplementation(async () => flushResult);
	snap = { fields: fields(), present: [], base: null, draftId: null, ready: false };
	parkable.mockClear();
	mirrorNow.mockClear();
	rescanMirror.mockClear();
	onCreated.mockClear();
	createdListeners = [];
	replace.mockClear();
	back.mockClear();
	navigate.mockClear();
	window.history.replaceState({ back: '/dashboard/postbox/inbox' }, '');
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', (meta: typeof pageMeta) => {
		pageMeta = meta;
	});
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
	vi.stubGlobal('usePostboxComposeNav', usePostboxComposeNav);
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
	vi.stubGlobal('usePostboxMailbox', () => ({ currentMailbox, isLoading: ref(false) }));
});

function mountPage() {
	return mount(ComposePage, {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposer: ComposerStub },
			stubs: { UiSkeleton: true },
		},
	});
}

const composer = (wrapper: ReturnType<typeof mountPage>) => wrapper.getComponent(ComposerStub);
const record = (key: string) => usePostboxComposeNav().read(key);

/** A request made the way `nav.open` makes one, shown at `?c=`. */
function openRequest(spec: Partial<ComposeSpec> = {}): string {
	const key = usePostboxComposeNav().create({ mailboxId: 'mbx-1' as never, ...spec });
	query = { c: key };
	return key;
}

/** A ready composer's snapshot. */
function readySnap(overrides: Partial<MirrorFields>, draftId: string | null = null) {
	snap = {
		fields: fields(overrides),
		present: [...MIRROR_FIELD_NAMES],
		base: null,
		draftId: draftId as never,
		ready: true,
	};
}

describe('compose page — the compose request', () => {
	it('gives a plain link a request, and replaces the URL with it before any composer mounts', async () => {
		query = { to: 'ada@example.com, bob@example.com', subject: 'Hi' };
		const wrapper = mountPage();
		expect(wrapper.findComponent(ComposerStub).exists()).toBe(false);
		expect(replace).toHaveBeenCalledOnce();
		const target = replace.mock.calls[0]![0] as { query: Record<string, string> };
		expect(Object.keys(target.query)).toEqual(['c']);
		const key = target.query['c']!;
		expect(record(key)!.seed).toEqual({
			mailboxId: 'mbx-1',
			prefillTo: ['ada@example.com', 'bob@example.com'],
			prefillCc: undefined,
			prefillBcc: undefined,
			prefillSubject: 'Hi',
		});
		await flushPromises();
		// Once: the effect stops after handing out the request.
		currentMailbox.value = { _id: 'mbx-2' };
		await flushPromises();
		expect(replace).toHaveBeenCalledOnce();

		// The rewrite changes the page key; the page mounts again under it.
		wrapper.unmount();
		query = target.query;
		const c = composer(mountPage());
		expect(c.props('seed')).toMatchObject({
			mailboxId: 'mbx-1',
			prefillTo: ['ada@example.com', 'bob@example.com'],
			prefillSubject: 'Hi',
			requestNonce: record(key)!.requestNonce,
		});
	});

	it('gives a link that names a draft a request that keeps the draft in the URL', () => {
		query = { mailbox: 'mbx-3', draft: 'draft-9' };
		mountPage();
		const target = replace.mock.calls[0]![0] as { query: Record<string, string> };
		expect(target.query).toEqual({ c: expect.any(String), mailbox: 'mbx-3', draft: 'draft-9' });
		const request = record(target.query['c']!)!;
		expect(request).toMatchObject({ mailboxId: 'mbx-3', draftId: 'draft-9' });
		expect(request.seed).toBeUndefined();
	});

	it('waits for the mailbox before giving a plain link a request', async () => {
		currentMailbox.value = null;
		query = { subject: 'Hi' };
		const wrapper = mountPage();
		expect(replace).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('No mailbox is configured');
		currentMailbox.value = { _id: 'mbx-1' };
		await nextTick();
		expect(replace).toHaveBeenCalledOnce();
	});

	it('says an unknown request has expired, rather than starting a second composition', async () => {
		query = { c: 'unknown' };
		const wrapper = mountPage();
		expect(wrapper.findComponent(ComposerStub).exists()).toBe(false);
		expect(wrapper.find('[data-testid="compose-expired"]').exists()).toBe(true);
		expect(record('unknown')).toBeNull();
		expect(replace).not.toHaveBeenCalled();

		// "Start a new message" opens a fresh request.
		await wrapper.get('[data-testid="compose-expired"] button').trigger('click');
		expect(navigate).toHaveBeenCalledWith({
			path: '/dashboard/compose',
			query: { c: expect.any(String) },
		});
	});

	it('reopens a saved draft named in the URL under an unknown request', () => {
		query = { c: 'copied', mailbox: 'mbx-3', draft: 'draft-9' };
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="compose-expired"]').exists()).toBe(false);
		expect(composer(wrapper).props('seed')).toEqual({
			mailboxId: 'mbx-3',
			draftId: 'draft-9',
			requestNonce: record('copied')!.requestNonce,
		});
	});

	it('seeds the composer with the request’s seed and nonce, in the page frame', () => {
		const key = openRequest({ prefillTo: ['jonas@example.com'], prefillSubject: 'Fwd: Q3' });
		const c = composer(mountPage());
		expect(c.props('frame')).toBe('page');
		expect(c.props('seed')).toEqual({
			mailboxId: 'mbx-1',
			prefillTo: ['jonas@example.com'],
			prefillSubject: 'Fwd: Q3',
			requestNonce: record(key)!.requestNonce,
		});
		expect(c.props('beforeReady')).toBeTypeOf('function');
	});

	it('passes a plain reply’s Reply-All extras through', () => {
		openRequest({ replyAllRecipients: ['cc@example.com'] });
		expect(composer(mountPage()).props('replyAllRecipients')).toEqual(['cc@example.com']);
	});

	it('binds a row the composer creates to the request', async () => {
		const key = openRequest({ prefillSubject: 'x' });
		mountPage();
		await nextTick();
		expect(onCreated).toHaveBeenCalledOnce();
		createdListeners[0]!('draft-5');
		expect(record(key)!.draftId).toBe('draft-5');
	});
});

describe('compose page — naming the draft in the URL', () => {
	it('keeps an offline undo’s text in the request until a save confirms it', async () => {
		// An offline undo hands back an existing draft id WITH newer, unsaved
		// text. The id arrives at once; naming it then would make a reload or a
		// Back load the older row and lose that text.
		const key = openRequest({
			draftId: 'draft-7' as never,
			prefillSubject: 'Edited offline',
			prefillBodyHtml: '<p>Newer text</p>',
		});
		flushResult = { ok: false };
		const wrapper = mountPage();

		composer(wrapper).vm.$emit('draft-id', 'draft-7');
		await flushPromises();
		expect(flush).toHaveBeenCalledOnce();
		expect(replace).not.toHaveBeenCalled();
		expect(record(key)!.seed?.prefillSubject).toBe('Edited offline');

		flushResult = { ok: true, result: 'draft-7' };
		composer(wrapper).vm.$emit('saved');
		await flushPromises();
		expect(record(key)!.seed).toEqual({ mailboxId: 'mbx-1', draftId: 'draft-7' });
		expect(replace).toHaveBeenCalledWith({
			query: { c: key, mailbox: 'mbx-1', draft: 'draft-7' },
		});
	});

	it('names a new draft once its first save confirms it', async () => {
		const key = openRequest();
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-1');
		await flushPromises();
		expect(record(key)!.draftId).toBe('draft-1');
		expect(replace).toHaveBeenCalledWith({
			query: { c: key, mailbox: 'mbx-1', draft: 'draft-1' },
		});
	});

	it('leaves the URL alone for a draft it already names', async () => {
		const key = usePostboxComposeNav().create({
			mailboxId: 'mbx-1' as never,
			draftId: 'draft-9' as never,
		});
		query = { c: key, mailbox: 'mbx-1', draft: 'draft-9' };
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-9');
		await nextTick();
		expect(replace).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});

	it('names a saved draft at once when the request carries no text', async () => {
		const key = usePostboxComposeNav().create({
			mailboxId: 'mbx-1' as never,
			draftId: 'draft-9' as never,
		});
		query = { c: key };
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-9');
		await nextTick();
		expect(flush).not.toHaveBeenCalled();
		expect(replace).toHaveBeenCalledWith({
			query: { c: key, mailbox: 'mbx-1', draft: 'draft-9' },
		});
	});

	it('leaves the URL alone once it shows another request', async () => {
		openRequest();
		const wrapper = mountPage();
		query = { c: 'someone-else' };
		composer(wrapper).vm.$emit('draft-id', 'draft-1');
		await flushPromises();
		expect(replace).not.toHaveBeenCalled();
	});

	it('confirms again when a save lands while an earlier confirmation runs', async () => {
		const key = openRequest({ draftId: 'draft-7' as never, prefillSubject: 'Edited offline' });
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
			query: { c: key, mailbox: 'mbx-1', draft: 'draft-7' },
		});
	});

	it('never rewrites the URL for a save that lands after the page closed', async () => {
		openRequest({ draftId: 'draft-7' as never, prefillSubject: 'Edited offline' });
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
});

describe('compose page — one instance per compose request', () => {
	it('keys the page on the request, which its own URL rewrite keeps', () => {
		openRequest();
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
		openRequest();
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('sent', { scheduled: false });
		composer(wrapper).vm.$emit('discarded');
		expect(back).toHaveBeenCalledTimes(2);
	});

	it('lands on the inbox when it was opened directly', () => {
		window.history.replaceState({}, '');
		openRequest();
		composer(mountPage()).vm.$emit('sent', { scheduled: false });
		expect(back).not.toHaveBeenCalled();
		expect(navigate).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
	});

	it('goes back on "←" and on Esc from outside a field', async () => {
		openRequest();
		const wrapper = mountPage();
		await wrapper.get('[data-testid="compose-back"]').trigger('click');
		expect(back).toHaveBeenCalledOnce();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(back).toHaveBeenCalledTimes(2);
	});
});

describe('compose page — parking unsaved text', () => {
	it('parks what the composer holds when the page is left', () => {
		const key = openRequest({ prefillSubject: 'Hi' });
		readySnap({ subject: 'Hi there', bodyHtml: '<p>Typed</p>' });
		mountPage().unmount();
		expect(parkable).toHaveBeenCalledOnce();
		expect(record(key)!.current).toMatchObject({
			rowless: true,
			fields: { subject: 'Hi there', bodyHtml: '<p>Typed</p>' },
		});
		// A return brings the parked text back as the seed.
		const c = composer(mountPage());
		expect(c.props('seed')).toMatchObject({
			prefillSubject: 'Hi there',
			prefillBodyHtml: '<p>Typed</p>',
		});
	});

	it('parks on pagehide, while the page stays mounted', () => {
		const key = openRequest({ draftId: 'draft-7' as never });
		snap = {
			fields: fields({ subject: 'Typed before load' }),
			present: ['subject'],
			base: null,
			draftId: 'draft-7' as never,
			ready: false,
		};
		const wrapper = mountPage();
		window.dispatchEvent(new Event('pagehide'));
		expect(parkable).toHaveBeenCalledOnce();
		expect(record(key)!.current).toMatchObject({
			present: ['subject'],
			base: null,
			rowless: false,
			fields: { subject: 'Typed before load' },
		});
		expect(wrapper.findComponent(ComposerStub).exists()).toBe(true);

		// The unmount that may follow replaces this mount's own park.
		const first = record(key)!.current!.id;
		wrapper.unmount();
		expect(record(key)!.sources).toEqual([]);
		expect(record(key)!.current!.id).not.toBe(first);
		// And the listener is gone with the page.
		parkable.mockClear();
		window.dispatchEvent(new Event('pagehide'));
		expect(parkable).not.toHaveBeenCalled();
	});

	it('parks nothing when the composer holds what the row holds', () => {
		const row = fields({ subject: 'Saved' });
		const key = openRequest({ draftId: 'draft-7' as never });
		snap = {
			fields: row,
			present: [...MIRROR_FIELD_NAMES],
			base: row,
			draftId: 'draft-7' as never,
			ready: true,
		};
		mountPage().unmount();
		expect(record(key)!.current).toBeUndefined();
	});

	it('forgets the request after a send or a discard, and parks nothing', async () => {
		const key = openRequest({ draftId: 'draft-7' as never, prefillSubject: 'Edited offline' });
		readySnap({ subject: 'Edited offline' }, 'draft-7');
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('sent', { scheduled: false });
		expect(record(key)).toBeNull();
		wrapper.unmount();
		await flushPromises();
		expect(parkable).not.toHaveBeenCalled();
		expect(record(key)).toBeNull();
		expect(flush).not.toHaveBeenCalled();
	});

	it('starts no save of its own on the way out', async () => {
		openRequest({ draftId: 'draft-7' as never, prefillSubject: 'Edited offline' });
		flushResult = { ok: false };
		const wrapper = mountPage();
		composer(wrapper).vm.$emit('draft-id', 'draft-7');
		await flushPromises();
		flush.mockClear();
		wrapper.unmount();
		await flushPromises();
		expect(flush).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});
});

describe('compose page — on-screen keyboard', () => {
	it('leaves the keyboard out of the frame, so Send stays above it', async () => {
		openRequest();
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
