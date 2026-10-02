// @vitest-environment happy-dom
/**
 * The composer's two frames (plan §04). The same composer, the same draft;
 * only what shows by default differs:
 *
 *   popup   — title bar (with "Open in Answer mode" on a reply), the full
 *             envelope, Coach and Revise under the editor: today's composer;
 *   answer  — no title bar, the envelope folded to one line that opens on
 *             click or when something in it needs attention, the quoted
 *             original folded out of the editor (still in the body, so the
 *             sent message is unchanged), Coach and Revise on demand.
 *
 * usePostboxCompose is replaced by plain refs: what is under test is the
 * frame, not the draft pipeline (which has its own suites).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h, reactive, ref, defineAsyncComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';

import PostboxComposer from '../PostboxComposer.vue';
import PostboxComposerEnvelopeLine from '../PostboxComposerEnvelopeLine.vue';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const QUOTED =
	'<p><br></p><br><br><div class="gmail_quote"><div>On Monday, Jonas wrote:</div>' +
	'<blockquote class="gmail_quote">Could you send the invoice?</blockquote></div>';

let compose: ReturnType<typeof makeCompose>;
/** The gate Cmd/Ctrl+Enter reads, as the composer handed it to its key handler. */
let keysCanSend: { value: boolean };
const flush = vi.fn(async () => ({ ok: true as const, result: 'draft_1' }));

function makeCompose() {
	return {
		draftId: ref<string | null>(null),
		toAddresses: ref(['Jonas Berg <jonas@example.com>']),
		ccAddresses: ref<string[]>([]),
		bccAddresses: ref<string[]>([]),
		subject: ref('Re: September invoice'),
		bodyHtml: ref(QUOTED),
		bodyBlocks: ref([]),
		composerMode: ref('simple'),
		fromAddress: ref('ada@example.com'),
		availableIdentities: ref([{ address: 'ada@example.com', mailboxId: 'mbx_1', label: 'Ada' }]),
		setIdentity: vi.fn(),
		signatures: ref([]),
		activeSignatureId: ref(null),
		applySignature: vi.fn(),
		attachments: ref([]),
		uploads: ref([]),
		attachmentSizeMeter: ref(null),
		thumbUrlFor: vi.fn(),
		addFiles: vi.fn(),
		removeAttachment: vi.fn(),
		shareAsLink: vi.fn(),
		isSharing: ref(false),
		cancelUpload: vi.fn(),
		retryUpload: vi.fn(),
		addInlineImage: vi.fn(),
		removeInlineImage: vi.fn(),
		isSaving: ref(false),
		lastSavedAt: ref<number | null>(null),
		draftMirror: reactive({ restorable: null, restore: vi.fn(), dismiss: vi.fn() }),
		draftNotice: ref(null),
		bodyPending: ref(false),
		retryLoad: vi.fn(),
		isUploading: ref(false),
		canSend: ref(true),
		isScheduled: ref(false),
		scheduledSendAt: ref(null),
		cancelSchedule: vi.fn(),
		followUpRemindAt: ref(null),
		isGapGuarded: ref(false),
		flush,
		send: vi.fn(),
		discard: vi.fn(async () => {}),
	};
}

const seal = reactive({
	enabled: false,
	state: null,
	pending: false,
	blockingRecipients: [] as string[],
	allVerified: false,
	confirmOpen: false,
	blockSend: async () => false,
	requestUnsealed: vi.fn(),
	confirmUnsealed: vi.fn(),
	setConfirmOpen: vi.fn(),
});

beforeEach(() => {
	compose = makeCompose();
	flush.mockClear();
	switchToReplyAll.mockClear();
	seal.blockingRecipients = [];
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		defineAsyncComponent,
		usePostboxCompose: () => compose,
		usePostboxGhostGate: () => ({ ghostSuggestionsEnabled: ref(false) }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
		useToast: () => ({ showToast: vi.fn() }),
		useOperationErrorToast: () => ({ showOperationError: vi.fn() }),
		usePostboxComposerSealLock: () => seal,
		usePostboxComposerSealChips: () => ({ chipSealStates: ref([]), removeSealBlocker: vi.fn() }),
		usePostboxToolbarPreference: () => ({ persistentToolbar: ref(false), toggleToolbar: vi.fn() }),
		usePostboxComposerSnippets: () => ({
			editorSnippets: ref([]),
			snippetInsert: ref({ variableContext: {} }),
			footer: {
				replies: computed(() => []),
				enabled: computed(() => false),
				currentBodyHtml: computed(() => ''),
				pickerOpen: ref(false),
				saveOpen: ref(false),
				pick: vi.fn(),
				handleKeydown: () => false,
			},
		}),
		usePostboxComposerSendGate: () => ({
			sending: ref(false),
			handleSend: vi.fn(),
			guards: reactive({ preflight: [], firstTime: { open: false } }),
			stale: reactive({ byName: null, confirmOpen: false, confirm: vi.fn() }),
		}),
		usePostboxComposerDropZone: () => ({
			rootEl: ref(null),
			dragActive: ref(false),
			onDragOver: vi.fn(),
			onDragLeave: vi.fn(),
			onDrop: vi.fn(),
			onPaste: vi.fn(),
		}),
		usePostboxComposerKeys: (opts: { canSend: { value: boolean } }) => {
			keysCanSend = opts.canSend;
			return {
				sendShortcutHint: ref('Send (Ctrl+Enter)'),
				scheduleShortcutHint: ref('Schedule send (Ctrl+Shift+Enter)'),
				onComposerKeydown: vi.fn(),
			};
		},
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		useInboxes: () => ({ byId: ref(new Map()) }),
		useBackendOperation: () => ({ run: vi.fn(async () => ({ ok: true })), isLoading: ref(false) }),
	});
});

/** The envelope: a stub that can raise the attention flag like the real one. */
const switchToReplyAll = vi.fn();
const EnvelopeStub = defineComponent({
	name: 'PostboxComposerEnvelope',
	emits: ['attention', 'apply-reply-all', 'from-change'],
	setup(_p, { expose }) {
		expose({ switchToReplyAll });
		return () => h('div', { 'data-testid': 'full-envelope' });
	},
});
const HeaderStub = defineComponent({
	name: 'PostboxComposerHeader',
	props: { subject: String, canMaximise: Boolean, maximising: Boolean },
	emits: ['maximise', 'minimize', 'discard'],
	setup: () => () => h('header', { 'data-testid': 'title-bar' }),
});
const EditorStub = defineComponent({
	name: 'PostboxBasicEditor',
	props: ['modelValue'],
	setup(props, { expose }) {
		expose({ focus: vi.fn() });
		return () => h('div', { class: 'postbox-basic-editor', innerHTML: props.modelValue });
	},
});
const inert = (name: string) =>
	defineComponent({ name, setup: () => () => h('div', { 'data-testid': name }) });

function mountComposer(props: Record<string, unknown>, slots: Record<string, unknown> = {}) {
	return mount(PostboxComposer, {
		props: { seed: { mailboxId: 'mbx_1', inReplyToMessageId: 'msg_1' }, ...props },
		slots: slots as never,
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxComposerHeader: HeaderStub,
				PostboxComposerEnvelope: EnvelopeStub,
				PostboxComposerEnvelopeLine,
				PostboxComposerFooter,
				PostboxBasicEditor: EditorStub,
				PostboxComposerAdvisory: inert('PostboxComposerAdvisory'),
				PostboxComposerDraftNotice: inert('PostboxComposerDraftNotice'),
				PostboxComposerSealLock: inert('PostboxComposerSealLock'),
				PostboxDraftRestoreBar: inert('PostboxDraftRestoreBar'),
				PostboxComposerScheduledBanner: inert('PostboxComposerScheduledBanner'),
				PostboxComposerAttachments: inert('PostboxComposerAttachments'),
				PostboxComposerDialogs: inert('PostboxComposerDialogs'),
			},
			stubs: {
				Icon: true,
				PostboxOverflowMenu: { template: '<div><slot :close="() => {}" /></div>' },
				PostboxComposerPreflightChip: true,
				PostboxPreviewAsSent: true,
				PostboxFollowUpDialog: true,
				PostboxComposerFollowUp: { template: '<button data-testid="follow-up" />' },
				PostboxComposerModeControls: true,
			},
		},
	});
}

const envelopeShown = (w: ReturnType<typeof mountComposer>) =>
	(w.get('[data-testid="full-envelope"]').element as HTMLElement).style.display !== 'none';

describe('PostboxComposer frame="answer"', () => {
	it('folds the envelope to one line, and opens it on click', async () => {
		const w = mountComposer({ frame: 'answer' });
		expect(w.find('[data-testid="title-bar"]').exists()).toBe(false);
		const line = w.get('[data-testid="composer-envelope-line"]');
		expect(line.text()).toContain('To Jonas Berg');
		// The identity's label, not its address.
		expect(line.text()).toContain('From Ada');
		expect(line.text()).not.toContain('ada@example.com');
		expect(line.text()).toContain('Re: September invoice');
		// Folded, not unmounted: its guard dialogs must stay live.
		expect(envelopeShown(w)).toBe(false);

		await line.get('button').trigger('click');
		expect(w.find('[data-testid="composer-envelope-line"]').exists()).toBe(false);
		expect(envelopeShown(w)).toBe(true);
		w.unmount();
	});

	it('names a bare reply address as the thread does ("To Jonas Berg", not "To finance")', () => {
		compose.toAddresses.value = ['finance@brightpath.example'];
		const w = mountComposer({
			frame: 'answer',
			recipientNames: { 'finance@brightpath.example': 'Jonas Berg' },
		});
		const line = w.get('[data-testid="composer-envelope-line"]').text();
		expect(line).toContain('To Jonas Berg');
		expect(line).not.toContain('To finance');
		w.unmount();
	});

	it('opens the envelope by itself when something in it needs attention', async () => {
		const w = mountComposer({ frame: 'answer' });
		w.getComponent(EnvelopeStub).vm.$emit('attention', true);
		await nextTick();
		expect(envelopeShown(w)).toBe(true);
		w.unmount();
	});

	it('opens it for a recipient blocking the seal too', async () => {
		seal.blockingRecipients = ['nokey@example.com'];
		const w = mountComposer({ frame: 'answer' });
		await nextTick();
		expect(envelopeShown(w)).toBe(true);
		w.unmount();
	});

	it('puts the reply-all switch on the folded line of a plain reply', async () => {
		const w = mountComposer({ frame: 'answer', replyAllRecipients: ['finance@example.com'] });
		await w.get('[data-testid="composer-envelope-reply-all"]').trigger('click');
		// The switch lives in the envelope; the line opens it and flips it.
		expect(envelopeShown(w)).toBe(true);
		expect(switchToReplyAll).toHaveBeenCalledTimes(1);
		w.unmount();
	});

	it('folds the quote out of the editor without touching the body', async () => {
		const w = mountComposer({ frame: 'answer' });
		const editorWrap = w.get('.postbox-basic-editor').element.parentElement!;
		expect(editorWrap.classList.contains('pbx-quote-folded')).toBe(true);
		// The quote is still in the body the draft saves and the send reads.
		expect(compose.bodyHtml.value).toBe(QUOTED);

		const toggle = w.get('[data-testid="composer-toggle-quote"]');
		expect(toggle.text()).toBe('Show quoted text');
		await toggle.trigger('click');
		expect(editorWrap.classList.contains('pbx-quote-folded')).toBe(false);
		expect(w.get('[data-testid="composer-toggle-quote"]').text()).toBe('Hide quoted text');
		expect(compose.bodyHtml.value).toBe(QUOTED);
		w.unmount();
	});

	it('keeps Coach and Revise under ⋯ until asked for', async () => {
		const w = mountComposer({ frame: 'answer' });
		expect(w.find('[data-testid="PostboxComposerAdvisory"]').exists()).toBe(false);
		await w.get('[data-testid="composer-toggle-advisory"]').trigger('click');
		expect(w.find('[data-testid="PostboxComposerAdvisory"]').exists()).toBe(true);
		w.unmount();
	});

	it('shows schedule, the follow-up chip and Discard in its footer', async () => {
		const w = mountComposer({ frame: 'answer' });
		expect(w.find('[data-testid="composer-schedule"]').exists()).toBe(true);
		expect(w.find('[data-testid="follow-up"]').exists()).toBe(true);
		await w.get('[data-testid="composer-discard"]').trigger('click');
		await nextTick();
		expect(compose.discard).toHaveBeenCalledTimes(1);
		expect(w.emitted('discarded')).toHaveLength(1);
		w.unmount();
	});

	it('lets its footer row wrap, so the status never sits under the buttons on a phone', () => {
		const w = mountComposer({ frame: 'answer' });
		expect(w.get('[data-testid="composer-footer-row"]').classes()).toContain('flex-wrap');
		w.unmount();
	});

	it('reports the draft row once it exists, for the URL', async () => {
		const w = mountComposer({ frame: 'answer' });
		expect(w.emitted('draft-id')).toBeUndefined();
		compose.draftId.value = 'draft_7';
		await nextTick();
		expect(w.emitted('draft-id')?.[0]).toEqual(['draft_7']);
		w.unmount();
	});

	it('holds Send back while an AI draft has a gap left, and says so where the save state was', async () => {
		const w = mountComposer({ frame: 'answer', statusNote: '1 of 2 asks covered' });
		const sendButton = () => w.findAll('button').find((b) => b.text() === 'Send')!;
		expect(sendButton().attributes('disabled')).toBeUndefined();
		expect(w.get('[data-testid="composer-save-state"]').text()).toBe('1 of 2 asks covered');

		const vm = w.vm as unknown as { answer: { applyAiDraft: (t: string) => Promise<void> } };
		await vm.answer.applyAiDraft('Attached. [[the PO number]]');
		await nextTick();
		expect(sendButton().attributes('disabled')).toBeDefined();
		expect(keysCanSend.value).toBe(false);
		expect(w.get('[data-testid="composer-save-state"]').text()).toBe('1 gap left');

		// A gap inside the quoted original is not this draft's.
		compose.bodyHtml.value = `<p>Attached.</p>${QUOTED.replace('the invoice', '[[x]]')}`;
		await nextTick();
		expect(sendButton().attributes('disabled')).toBeUndefined();
		expect(keysCanSend.value).toBe(true);
		w.unmount();
	});

	it('leaves double brackets the person typed to the advisory chip: Send and Cmd+Enter stay live', async () => {
		const w = mountComposer({ frame: 'answer', statusNote: '1 of 2 asks covered' });
		const sendButton = () => w.findAll('button').find((b) => b.text() === 'Send')!;

		compose.bodyHtml.value = `<p>See [[Onboarding checklist]] in the wiki.</p>${QUOTED}`;
		await nextTick();

		expect(sendButton().attributes('disabled')).toBeUndefined();
		expect(keysCanSend.value).toBe(true);
		expect(w.get('[data-testid="composer-save-state"]').text()).toBe('1 of 2 asks covered');
		w.unmount();
	});

	it('holds Send on a resumed draft whose ask session the host reports', async () => {
		const w = mountComposer({ frame: 'answer', askSession: true });
		compose.bodyHtml.value = `<p>Attached. [[the PO number]]</p>${QUOTED}`;
		await nextTick();

		expect(keysCanSend.value).toBe(false);
		expect(w.get('[data-testid="composer-save-state"]').text()).toBe('1 gap left');
		w.unmount();
	});

	// Issue #1131 review: a reopened Reply Queue draft has no ask session and no
	// in-memory AI draft; the saved row's `isGapGuarded` keeps Send held.
	it('holds Send on a reopened draft the AI left gaps in, without an ask session', async () => {
		compose.isGapGuarded.value = true;
		const w = mountComposer({ frame: 'answer' });
		compose.bodyHtml.value = `<p>Here they are. [[Provide the invoices]]</p>${QUOTED}`;
		await nextTick();

		expect(keysCanSend.value).toBe(false);
		expect(w.get('[data-testid="composer-save-state"]').text()).toBe('1 gap left');
		w.unmount();
		compose.isGapGuarded.value = false;
	});

	it('hands its slot and its host the Answer mode API', async () => {
		const w = mountComposer(
			{ frame: 'answer' },
			{
				'above-editor': ({ composer }: { composer: { draftText: { value: string } } }) =>
					h('p', { 'data-testid': 'slot' }, composer.draftText.value),
			}
		);
		compose.bodyHtml.value = `<p>Hi Jonas</p>${QUOTED}`;
		await nextTick();
		expect(w.get('[data-testid="slot"]').text()).toBe('Hi Jonas');
		const vm = w.vm as unknown as { answer: { applyAiDraft: (t: string) => Promise<void> } };
		await vm.answer.applyAiDraft('Here it is.');
		// The empty paragraph the reply opened with was the written part.
		expect(compose.bodyHtml.value).toBe(`<p>Here it is.</p>${QUOTED.replace('<p><br></p>', '')}`);
		expect(flush).toHaveBeenCalled();
		w.unmount();
	});

	it('tells the host whether the draft holds anything the person wrote', () => {
		const w = mountComposer({ frame: 'answer' });
		const vm = w.vm as unknown as { snapshot: () => { hasContent: boolean } };
		expect(vm.snapshot().hasContent).toBe(false);
		compose.bodyHtml.value = `<p>Attached.</p>${QUOTED}`;
		expect(vm.snapshot().hasContent).toBe(true);
		w.unmount();
	});
});

describe('PostboxComposer frame="popup"', () => {
	it("is today's composer: title bar, full envelope, quote in view, Coach inline", () => {
		const w = mountComposer({});
		expect(w.find('[data-testid="title-bar"]').exists()).toBe(true);
		expect(w.find('[data-testid="composer-envelope-line"]').exists()).toBe(false);
		expect(envelopeShown(w)).toBe(true);
		expect(w.get('.postbox-basic-editor').element.parentElement!.classList).not.toContain(
			'pbx-quote-folded'
		);
		expect(w.find('[data-testid="PostboxComposerAdvisory"]').exists()).toBe(true);
		expect(w.find('[data-testid="composer-toggle-quote"]').exists()).toBe(false);
		w.unmount();
	});

	it('keeps the popup footer on one line, as before', () => {
		const w = mountComposer({});
		expect(w.get('[data-testid="composer-footer-row"]').classes()).not.toContain('flex-wrap');
		w.unmount();
	});

	it('offers "Open in Answer mode" on a reply, saving the draft first', async () => {
		const w = mountComposer({});
		expect(w.getComponent(HeaderStub).props('canMaximise')).toBe(true);
		w.getComponent(HeaderStub).vm.$emit('maximise');
		await nextTick();
		await nextTick();
		expect(flush).toHaveBeenCalledTimes(1);
		expect(w.emitted('maximise')?.[0]).toEqual(['draft_1']);
		w.unmount();
	});

	it('stays in the popup when the save before Answer mode did not land', async () => {
		flush.mockResolvedValueOnce({ ok: false } as never);
		const w = mountComposer({});
		w.getComponent(HeaderStub).vm.$emit('maximise');
		await nextTick();
		await nextTick();
		expect(flush).toHaveBeenCalledTimes(1);
		expect(w.emitted('maximise')).toBeUndefined();
		w.unmount();
	});

	it('offers no Answer mode for a new email', () => {
		const w = mountComposer({ seed: { mailboxId: 'mbx_1' } });
		expect(w.getComponent(HeaderStub).props('canMaximise')).toBe(false);
		w.unmount();
	});
});
