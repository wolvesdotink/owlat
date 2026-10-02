// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import ThreadComposer from '../ThreadComposer.vue';
import PostboxComposerPreflightChip from '../../postbox/PostboxComposerPreflightChip.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const platform = ref('linux');
// The saved replies the composer may insert, and the "it went in" counter.
const savedReplies = ref<unknown[]>([]);
const recordUse = vi.fn(async () => ({ ok: true, result: null }));
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useDesktopContext: () => ({ platform }),
		// The shared Postbox footer's own lookups (send-as name, native picker).
		useInboxes: () => ({ byId: ref(new Map()) }),
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		// Insert availability (booking page) in the footer's ⋯ menu stays off.
		useToast: () => ({ showToast: vi.fn() }),
		// Saved replies: the list, the use counter, the writer's name, the palette.
		useFeatureFlag: () => ({ isEnabled: (flag: string) => flag !== 'calendar.booking' }),
		useConvexQuery: () => ({ data: savedReplies, isLoading: ref(false), error: ref(null) }),
		useBackendOperation: () => ({ run: recordUse, isLoading: ref(false) }),
		useAuth: () => ({ user: ref({ name: 'Mira Holt', email: 'mira@owlat.example' }) }),
		useState: (_key: string, init: () => unknown) => ref(init()),
		registerCommandPaletteProvider: vi.fn(),
		usePermissions: () => ({ isAdmin: ref(false) }),
	});
});
afterEach(() => {
	savedReplies.value = [];
	recordUse.mockClear();
});
enableAutoUnmount(afterEach);

/**
 * The Team inbox reply in Answer mode's composer column (#765, plan §07):
 *  - no agent draft: an empty editor that sends what the person typed;
 *  - an agent draft: the editor opens with it, Send approves it as is (the
 *    fast path), an edit sends the person's text; under ⋯ the changes against
 *    the agent's original, "Write my own" (clear), "Discard draft" (reject);
 *  - a teammate replying holds Send, and its label says who;
 *  - a state no reply can go to: no editor, a plain reason instead.
 */
// The ⋯ menu renders its items inline, so a test can click them.
const ModalStub = defineComponent({
	name: 'UiModal',
	props: { open: Boolean, title: { type: String, default: '' } },
	setup:
		(props, { slots }) =>
		() =>
			props.open ? h('div', { role: 'dialog' }, slots.default?.()) : null,
});
const MenuStub = defineComponent({
	name: 'PostboxOverflowMenu',
	setup:
		(_p, { slots }) =>
		() =>
			h('div', { 'data-testid': 'menu' }, slots.default?.({ close: () => {} })),
});

function mountComposer(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
	return mount(ThreadComposer, {
		props: {
			target: { kind: 'teamThread', threadId: 'th_1', inboundMessageId: 'in_1' },
			senderLabel: 'Ana Ruiz',
			...props,
		},
		slots,
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposerPreflightChip },
			stubs: {
				Icon: true,
				PostboxOverflowMenu: MenuStub,
				UiModal: ModalStub,
				// The mailbox-only controls of the shared footer, never shown here.
				PostboxComposerFollowUp: true,
				PostboxComposerModeControls: true,
				PostboxFollowUpDialog: true,
				PostboxPreviewAsSent: true,
			},
		},
	});
}

describe('InboxThreadComposer send hint and ⋯', () => {
	it('names the send chord for this machine: Ctrl on Linux, ⌘ on a Mac', () => {
		platform.value = 'linux';
		expect(mountComposer().get('kbd').text()).toBe('Ctrl Enter');
		platform.value = 'mac';
		expect(mountComposer().get('kbd').text()).toBe('⌘ Enter');
		platform.value = 'linux';
	});
});

describe('InboxThreadComposer and the gaps the AI left', () => {
	const sendButton = (w: ReturnType<typeof mountComposer>) =>
		w.get('[data-testid="composer-send"]');

	it('holds Send and says how many gaps are left after an AI draft', async () => {
		const wrapper = mountComposer({ statusNote: '1 of 2 asks covered' });
		const vm = wrapper.vm as unknown as { answer: { applyAiDraft: (t: string) => Promise<void> } };
		await vm.answer.applyAiDraft('Attached [[the invoice]].');
		await nextTick();
		expect(sendButton(wrapper).attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="composer-save-state"]').text()).toBe('1 gap left');

		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Attached the invoice.');
		expect(sendButton(wrapper).attributes('disabled')).toBeUndefined();
		expect(wrapper.get('[data-testid="composer-save-state"]').text()).toBe('1 of 2 asks covered');
	});

	it('holds Send when the thread has a Draft with AI session (the server would refuse)', async () => {
		const wrapper = mountComposer({ askSession: true });
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('See [[the PO]].');
		expect(sendButton(wrapper).attributes('disabled')).toBeDefined();
	});

	it('leaves brackets a person typed alone', async () => {
		const wrapper = mountComposer();
		await wrapper
			.get('[data-testid="thread-composer-body"]')
			.setValue('See [[Onboarding]] in the wiki.');
		expect(sendButton(wrapper).attributes('disabled')).toBeUndefined();
	});
});

describe('InboxThreadComposer in Answer mode', () => {
	it('opens an empty editor on a thread without a draft, and sends the typed text', async () => {
		const wrapper = mountComposer();
		expect(wrapper.get('[data-testid="thread-composer-envelope"]').text()).toContain('To Ana Ruiz');
		const body = wrapper.get('[data-testid="thread-composer-body"]');
		await body.setValue('We have refunded the invoice.');
		await wrapper.get('[data-testid="composer-send"]').trigger('click');

		expect(wrapper.emitted('send')?.[0]).toEqual([
			'We have refunded the invoice.',
			false,
			'',
			false,
		]);
		expect(wrapper.get('[data-testid="composer-send"]').text()).toBe('Send reply');
	});

	it('does not send an empty reply', async () => {
		const wrapper = mountComposer();
		const send = wrapper.get('[data-testid="composer-send"]');
		expect(send.attributes('disabled')).toBeDefined();
		await send.trigger('click');
		expect(wrapper.emitted('send')).toBeUndefined();
	});

	it('opens with the agent draft in the editor; Send approves it unchanged', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana, here is your invoice.' });
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('Hi Ana, here is your invoice.');
		expect(wrapper.get('[data-testid="thread-composer-draft-hint"]').text()).toBe(
			'Drafted by the agent'
		);

		await wrapper.get('[data-testid="composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual([
			'Hi Ana, here is your invoice.',
			true,
			'',
			false,
		]);
	});

	it('sends an edited draft as the person’s own text; the changes are under ⋯', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.', originalDraft: 'Hi Ana.' });
		await wrapper
			.get('[data-testid="thread-composer-body"]')
			.setValue('Hi Ana, sorry for the wait.');
		expect(wrapper.get('[data-testid="thread-composer-draft-hint"]').text()).toBe('Edited draft');

		// The diff is not in the way until asked for.
		expect(wrapper.find('[data-testid="thread-composer-diff"]').exists()).toBe(false);
		await wrapper.get('[data-testid="thread-composer-show-changes"]').trigger('click');
		expect(wrapper.get('[data-testid="thread-composer-diff"]').text()).toContain('Hi Ana.');

		await wrapper.get('[data-testid="composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana, sorry for the wait.', false, '', false]);

		await wrapper.get('[data-testid="thread-composer-save"]').trigger('click');
		expect(wrapper.emitted('save')?.[0]).toEqual(['Hi Ana, sorry for the wait.', '', false]);
	});

	it('"Write my own" clears the editor so the person can start over', async () => {
		const wrapper = mountComposer({ draft: 'A draft that is wrong.' });
		await wrapper.get('[data-testid="thread-composer-write-own"]').trigger('click');
		await nextTick();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('');
		expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined();
	});

	it('"Discard draft" rejects the agent draft; a plain reply only clears', async () => {
		const withDraft = mountComposer({ draft: 'Draft' });
		await withDraft.get('[data-testid="thread-composer-skip"]').trigger('click');
		expect(withDraft.emitted('reject')).toHaveLength(1);

		const plain = mountComposer();
		expect(plain.find('[data-testid="thread-composer-skip"]').exists()).toBe(false);
		await plain.get('[data-testid="thread-composer-body"]').setValue('Scratch that');
		await plain.get('[data-testid="thread-composer-clear"]').trigger('click');
		expect(
			plain.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]').element.value
		).toBe('');
		expect(plain.emitted('reject')).toBeUndefined();
	});

	it('sends with Cmd/Ctrl+Enter from the editor', async () => {
		const wrapper = mountComposer();
		const body = wrapper.get('[data-testid="thread-composer-body"]');
		await body.setValue('Done.');
		await body.trigger('keydown', { key: 'Enter', ctrlKey: true });
		expect(wrapper.emitted('send')?.[0]).toEqual(['Done.', false, '', false]);
	});

	it('holds Send while a teammate is replying, and says who on the button', async () => {
		const wrapper = mountComposer({
			draft: 'Draft',
			held: true,
			heldBy: 'Priya',
			heldReason: 'held while Priya is editing',
		});
		const send = wrapper.get('[data-testid="composer-send"]');
		expect(send.text()).toBe('Priya is replying');
		expect(send.attributes('disabled')).toBeDefined();
		await send.trigger('click');
		expect(wrapper.emitted('send')).toBeUndefined();
		expect(wrapper.get('[data-testid="thread-composer-held"]').text()).toContain(
			'held while Priya is editing'
		);
	});

	it('holds Send while an attachment is not ready, with the reason', async () => {
		const wrapper = mountComposer({
			draft: 'Draft',
			sendHold: 'Send waits until the file is copied.',
		});
		expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="thread-composer-send-hold"]').text()).toBe(
			'Send waits until the file is copied.'
		);
	});

	it('explains why no reply can go out instead of offering an editor', () => {
		const wrapper = mountComposer({ blocker: 'processing', draft: 'ignored' });
		expect(wrapper.find('[data-testid="thread-composer-body"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-composer-blocked"]').text()).toContain(
			'Owlat is still reading this message.'
		);
	});

	// #807 — the agent still drafting, or the message already answered, no longer
	// block the editor: it opens, and says where the text goes.
	it('says a reply sent mid-draft replaces the agent draft', async () => {
		const wrapper = mountComposer({ notice: 'takesOverDraft' });
		expect(wrapper.get('[data-testid="thread-composer-notice"]').text()).toContain(
			'The agent is still drafting.'
		);
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Here is the answer.');
		await wrapper.get('[data-testid="composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Here is the answer.', false, '', false]);
	});

	it('marks a reply to an answered message as a follow-up', () => {
		const wrapper = mountComposer({ notice: 'followUp' });
		expect(wrapper.find('[data-testid="thread-composer-blocked"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="thread-composer-notice"]').text()).toBe(
			'Already answered. This goes out as a follow-up.'
		);
	});

	it('takes text handed back (an undone follow-up, kept text) and reports it as typed', async () => {
		const wrapper = mountComposer({ subject: 'Re: Invoice' });
		const vm = wrapper.vm as unknown as {
			fill: (b: string, s: string) => void;
			snapshot: () => { body: string; subject: string; touched: boolean; gapGuarded: boolean };
		};
		vm.fill('The CSV has both variants.', 'Re: Invoice');
		await nextTick();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('The CSV has both variants.');
		expect(vm.snapshot()).toEqual({
			body: 'The CSV has both variants.',
			subject: 'Re: Invoice',
			touched: true,
			gapGuarded: false,
		});
	});

	it('sends under the pre-filled subject, and an edited subject is the person’s own', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.', subject: 'Re: Invoice' });
		expect(wrapper.get('[data-testid="thread-composer-envelope"]').text()).toContain('Re: Invoice');
		await wrapper.get('[data-testid="thread-composer-envelope"]').trigger('click');
		const subject = wrapper.get('[data-testid="thread-composer-subject"]');
		expect((subject.element as HTMLInputElement).value).toBe('Re: Invoice');

		await subject.setValue('Re: Invoice 1042');
		await wrapper.get('[data-testid="composer-send"]').trigger('click');
		expect(wrapper.emitted('send')?.[0]).toEqual(['Hi Ana.', false, 'Re: Invoice 1042', false]);
	});

	it('focuses the editor as it opens', async () => {
		const wrapper = mountComposer();
		await nextTick();
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="thread-composer-body"]').element
		);
	});

	it('reports typing so the "is replying" presence follows the composer', async () => {
		const wrapper = mountComposer();
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Hel');
		expect(wrapper.emitted('typing')?.at(-1)).toEqual([true]);
	});

	it('places the agent questions above the editor and the files below it', () => {
		const wrapper = mountComposer(
			{},
			{
				'above-editor': '<div data-testid="ask" />',
				attachments: '<div data-testid="files" />',
			}
		);
		const html = wrapper.html();
		expect(html.indexOf('data-testid="ask"')).toBeLessThan(
			html.indexOf('data-testid="thread-composer-body"')
		);
		expect(html.indexOf('data-testid="files"')).toBeGreaterThan(
			html.indexOf('data-testid="thread-composer-body"')
		);
	});

	// #812 — the team reply is a composer target, so the Postbox composer's
	// advisory pre-send checks run on it too.
	it('flags a placeholder the agent left in its draft, and clears once fixed', async () => {
		const wrapper = mountComposer({
			draft: 'The refund is queued [TODO: add settlement date].',
			subject: 'Re: Invoice',
		});
		expect(wrapper.get('[data-testid="postbox-preflight-chip"]').text()).toContain(
			'[TODO: add settlement date]'
		);

		await wrapper
			.get('[data-testid="thread-composer-body"]')
			.setValue('The refund settles on Friday.');
		expect(wrapper.find('[data-testid="postbox-preflight-chip"]').exists()).toBe(false);
	});

	it('does not ask for a subject a team reply is given anyway', async () => {
		const wrapper = mountComposer();
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('All sorted.');
		expect(wrapper.find('[data-testid="postbox-preflight-chip"]').exists()).toBe(false);
	});
});

// #812 — the team reply renders inside the Postbox composer's frame and
// footer; the footer reads the team target's capabilities and leaves out what
// a team reply cannot carry.
describe('InboxThreadComposer in the shared Postbox composer shell', () => {
	it('renders in the shell as a team-thread target, its editor in the scroll region', () => {
		const wrapper = mountComposer();
		const shell = wrapper.get('[data-composer-target="teamThread"]');
		expect(
			shell
				.get('[data-testid="composer-scroll"]')
				.find('[data-testid="thread-composer-body"]')
				.exists()
		).toBe(true);
		// Send sits in the footer, outside the region, so it never scrolls away.
		expect(
			shell.get('[data-testid="composer-scroll"]').find('[data-testid="composer-send"]').exists()
		).toBe(false);
		expect(shell.find('footer [data-testid="composer-send"]').exists()).toBe(true);
	});

	it('offers none of the mailbox draft’s controls: no attach, schedule, reminder, signature, preview or editor mode', async () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.' });
		await wrapper.get('[data-testid="thread-composer-body"]').setValue('Hi Ana, sorted.');
		const footer = wrapper.get('footer');
		expect(footer.find('input[type="file"]').exists()).toBe(false);
		expect(footer.find('[data-testid="composer-schedule"]').exists()).toBe(false);
		expect(footer.find('[data-testid="postbox-send-as"]').exists()).toBe(false);
		expect(footer.find('[data-testid="composer-discard"]').exists()).toBe(false);
		expect(footer.find('select').exists()).toBe(false);
		for (const stub of [
			'postbox-composer-follow-up-stub',
			'postbox-follow-up-dialog-stub',
			'postbox-preview-as-sent-stub',
			'postbox-composer-mode-controls-stub',
		]) {
			expect(footer.find(stub).exists()).toBe(false);
		}
		// The ⋯ menu holds the reply's own items, under its own name.
		const menu = footer.get('[data-testid="menu"]');
		expect(menu.attributes('label')).toBe('More for this reply');
		expect(menu.findAll('[role="menuitem"]').map((item) => item.attributes('data-testid'))).toEqual(
			[
				'thread-composer-show-changes',
				'thread-composer-save',
				'thread-composer-restore',
				'thread-composer-write-own',
				'thread-composer-skip',
			]
		);
	});

	it('keeps the Send label while a save or send is in flight', () => {
		const wrapper = mountComposer({ draft: 'Hi Ana.', busy: true });
		const send = wrapper.get('[data-testid="composer-send"]');
		expect(send.text()).toBe('Send reply');
		expect(send.attributes('disabled')).toBeDefined();
	});
});

describe('InboxThreadComposer and saved replies', () => {
	const refund = {
		_id: 'sn_1',
		name: 'Refund',
		shortcut: 'refund',
		bodyHtml: '<p>Hi {{contact.firstName}},</p><p>your refund is on its way. {{me.firstName}}</p>',
		scope: 'personal',
		useCount: 3,
		lastUsedAt: 1,
	};
	const order = {
		_id: 'sn_2',
		name: 'Order status',
		shortcut: 'order',
		bodyHtml: '<p>Order [[order number]] for {{contact.lastName}} ships today.</p>',
		scope: 'shared',
		useCount: 0,
		lastUsedAt: null,
	};
	const body = (w: ReturnType<typeof mountComposer>) =>
		w.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');

	async function type(w: ReturnType<typeof mountComposer>, text: string) {
		const textarea = body(w);
		textarea.element.value = text;
		textarea.element.setSelectionRange(text.length, text.length);
		await textarea.trigger('input');
	}

	it('inserts the reply a typed ";" and shortcut picks, with its variables filled in', async () => {
		savedReplies.value = [refund, order];
		const wrapper = mountComposer({ recipient: { firstName: 'Ana', lastName: 'Ruiz' } });
		await type(wrapper, 'Hello\n;ref');
		expect(wrapper.findAll('[role="option"]').map((o) => o.text())).toEqual(['Refund;refund']);

		await body(wrapper).trigger('keydown', { key: 'Enter' });
		expect(body(wrapper).element.value).toBe('Hello\nHi Ana,\n\nyour refund is on its way. Mira');
		expect(wrapper.find('[role="option"]').exists()).toBe(false);
		expect(recordUse).toHaveBeenCalledWith({ replyId: 'sn_1' });
		expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeUndefined();
	});

	it('does not open over a ";" nothing matches, nor in the middle of a word', async () => {
		savedReplies.value = [refund];
		const wrapper = mountComposer();
		await type(wrapper, 'Thanks ;)');
		expect(wrapper.find('[role="option"]').exists()).toBe(false);
		await type(wrapper, 'a;ref');
		expect(wrapper.find('[role="option"]').exists()).toBe(false);
		// `/` is only the Postbox's older trigger.
		await type(wrapper, 'see /ref');
		expect(wrapper.find('[role="option"]').exists()).toBe(false);
	});

	it('turns what it cannot fill into gaps that hold Send until they are filled', async () => {
		savedReplies.value = [order];
		const wrapper = mountComposer();
		await type(wrapper, ';order');
		await body(wrapper).trigger('keydown', { key: 'Tab' });

		expect(body(wrapper).element.value).toBe(
			'Order [[order number]] for [[Recipient’s last name]] ships today.'
		);
		const send = wrapper.get('[data-testid="composer-send"]');
		expect(send.attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="composer-save-state"]').text()).toBe('2 gaps left');

		await body(wrapper).setValue('Order 4471 for Ruiz ships today.');
		expect(send.attributes('disabled')).toBeUndefined();
	});

	it('opens the picker with Ctrl+; and inserts the chosen reply at the caret', async () => {
		savedReplies.value = [order, refund];
		const wrapper = mountComposer({ recipient: { firstName: 'Ana' } });
		await type(wrapper, 'Thanks!');
		await body(wrapper).trigger('keydown', { key: ';', ctrlKey: true });
		const picker = wrapper.get('[data-testid="saved-reply-picker"]');
		// The most used first, before anything is typed; a shared one is marked.
		expect(picker.findAll('[role="option"]').map((o) => o.text())).toEqual([
			expect.stringContaining('Refund'),
			expect.stringContaining('Order status'),
		]);
		await picker.get('input').setValue('ordr');
		expect(picker.findAll('[role="option"]')).toHaveLength(1);
		await picker.get('input').trigger('keydown', { key: 'Enter' });

		expect(wrapper.find('[data-testid="saved-reply-picker"]').exists()).toBe(false);
		expect(body(wrapper).element.value).toBe(
			'Thanks!Order [[order number]] for [[Recipient’s last name]] ships today.'
		);
	});

	it('replaces the ";token" at the caret, also after the caret moved without typing', async () => {
		savedReplies.value = [refund];
		const wrapper = mountComposer({ recipient: { firstName: 'Ana' } });
		await type(wrapper, 'Hi ;ref');
		expect(wrapper.find('[role="option"]').exists()).toBe(true);

		// ← past the ";" closes the dropdown, so Enter is a newline again.
		const textarea = body(wrapper);
		textarea.element.setSelectionRange(2, 2);
		await textarea.trigger('keyup', { key: 'ArrowLeft' });
		expect(wrapper.find('[role="option"]').exists()).toBe(false);

		// Back at the end of the token, Enter replaces exactly the token.
		textarea.element.setSelectionRange(7, 7);
		await textarea.trigger('keyup', { key: 'End' });
		await textarea.trigger('keydown', { key: 'Enter' });
		expect(textarea.element.value).toBe('Hi Hi Ana,\n\nyour refund is on its way. Mira');
	});

	it('keeps holding Send for a saved reply’s gaps when the text is put back', async () => {
		savedReplies.value = [order];
		const wrapper = mountComposer();
		await type(wrapper, ';order');
		await body(wrapper).trigger('keydown', { key: 'Enter' });
		const kept = (wrapper.vm as unknown as { snapshot: () => Record<string, unknown> }).snapshot();
		expect(kept).toMatchObject({ gapGuarded: true });

		// The thread is opened again: the kept text goes back in with its guard.
		const again = mountComposer();
		const api = again.vm as unknown as {
			fill: (body: string, subject: string, gapGuarded?: boolean) => void;
		};
		api.fill(String(kept['body']), '', true);
		await nextTick();
		expect(again.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined();
		api.fill('Order [[order number]] ships.', '');
		await nextTick();
		expect(again.get('[data-testid="composer-send"]').attributes('disabled')).toBeUndefined();
	});

	it('saves the gap guard with the working draft, and a reload of it keeps holding Send', async () => {
		savedReplies.value = [order];
		const wrapper = mountComposer({ draft: 'Thanks for writing.' });
		await type(wrapper, ';order');
		await body(wrapper).trigger('keydown', { key: 'Enter' });
		await wrapper.get('[data-testid="thread-composer-save"]').trigger('click');
		const [savedText, , guard] = wrapper.emitted('save')?.[0] ?? [];
		expect(guard).toBe(true);

		// A full reload: the stored draft comes back with its stored guard.
		const reloaded = mountComposer({ draft: savedText, draftGapGuarded: true });
		const send = reloaded.get('[data-testid="composer-send"]');
		expect(send.attributes('disabled')).toBeDefined();
		expect(reloaded.get('[data-testid="composer-save-state"]').text()).toBe('2 gaps left');

		// Filled in, it sends, and the guard still rides along.
		await body(reloaded).setValue('Order 4471 for Ruiz ships today.');
		expect(send.attributes('disabled')).toBeUndefined();
		await send.trigger('click');
		expect(reloaded.emitted('send')?.[0]?.[3]).toBe(true);
	});

	it('takes the stored guard back with "Restore draft", and drops it for "Write my own"', async () => {
		const gapped = 'Order [[order number]] ships today.';
		const wrapper = mountComposer({ draft: gapped, draftGapGuarded: true });
		const send = () => wrapper.get('[data-testid="composer-send"]').attributes('disabled');
		expect(send()).toBeDefined();

		await wrapper.get('[data-testid="thread-composer-write-own"]').trigger('click');
		await type(wrapper, 'See [[wiki link]].');
		expect(send()).toBeUndefined();

		await wrapper.get('[data-testid="thread-composer-restore"]').trigger('click');
		await nextTick();
		expect(body(wrapper).element.value).toBe(gapped);
		expect(send()).toBeDefined();

		// Without a stored guard, double brackets in a saved draft are the person's own.
		const plain = mountComposer({ draft: 'See [[wiki link]].' });
		expect(plain.get('[data-testid="composer-send"]').attributes('disabled')).toBeUndefined();
	});

	it('offers to save what was written as a new reply', async () => {
		const wrapper = mountComposer();
		await wrapper.get('[data-testid="saved-reply-button"]').trigger('click');
		const save = wrapper.get('[data-testid="saved-reply-save-current"]');
		expect(save.attributes('disabled')).toBeDefined();

		await type(wrapper, 'We have refunded the invoice.');
		await wrapper.get('[data-testid="saved-reply-button"]').trigger('click');
		await wrapper.get('[data-testid="saved-reply-save-current"]').trigger('click');
		expect(wrapper.get('[data-testid="saved-reply-save-dialog"]').text()).toContain(
			'We have refunded the invoice.'
		);
	});
});
