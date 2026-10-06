// @vitest-environment happy-dom
/**
 * #1257: an attachment the open asked for (an RSVP's generated `reply.ics`, a
 * forward's copied files) that is still uploading when the page reloads.
 *
 * The compose page names the draft in its URL once the text is saved, and a
 * reload then reopens that draft. These cases run the real compose page, the
 * real compose request record and the real composer state machine
 * (`usePostboxCompose`) against a small in-memory server: a draft row, the
 * upload transport and `drafts.addAttachment`. A reload is the page unmounting
 * with the tab's memory (session state) gone and its sessionStorage kept.
 *
 *   - the RSVP still uploading at the reload is uploaded again, and Send waits
 *     for it;
 *   - an attach that was in flight at the reload and lands (before or after
 *     the reopened page looks) leaves exactly one `reply.ics`;
 *   - a forward re-copies only the file that had not reached the row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref, watch, type Ref } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';

import ComposePage from '../compose.vue';
import { usePostboxComposeNav, type ComposeSpec } from '~/composables/postbox/usePostboxComposeNav';
import { usePostboxCompose } from '~/composables/postbox/usePostboxCompose';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mail: {
			drafts: {
				get: 'drafts.get',
				create: 'drafts.create',
				update: 'drafts.update',
				setIdentity: 'drafts.setIdentity',
				discard: 'drafts.discard',
				send: 'drafts.send',
				cancelPendingSend: 'drafts.cancelPendingSend',
				cancelScheduledSend: 'drafts.cancelScheduledSend',
				addAttachment: 'drafts.addAttachment',
				removeAttachment: 'drafts.removeAttachment',
			},
			attachmentSharesActions: { shareDraftAttachment: 'shares.shareDraftAttachment' },
			identities: {
				listForOwnedMailbox: 'identities.list',
				listSendAsIdentities: 'identities.listSendAs',
			},
			signatures: { list: 'signatures.list' },
			settings: { get: 'settings.get', update: 'settings.update' },
		},
	},
}));
vi.mock('~/composables/useKeyboardInset', () => ({ useKeyboardInset: () => ref(0) }));
vi.mock('~/composables/postbox/usePostboxUndoSend', () => ({
	usePostboxUndoSend: () => ({ arm: () => {} }),
}));

// The upload's bytes go out over XHR; each one is held until the case lets it finish.
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
const puts: { file: File; done: Deferred<string> }[] = [];
vi.mock('~/composables/postbox/postboxAttachmentUploads', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/composables/postbox/postboxAttachmentUploads')>()),
	xhrPutFile: (_url: string, file: File) => {
		const done = deferred<string>();
		puts.push({ file, done });
		return done.promise;
	},
}));

// ── The server: one draft row ──────────────────────────────────────────────

interface RowAttachment {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}
interface Row {
	toAddresses: string[];
	subject: string;
	bodyHtml: string;
	composerMode: 'simple';
	state: 'draft';
	lastEditedAt: number;
	attachments: RowAttachment[];
}
const DRAFT = 'draft-1';
let row: Row | null;
let rowNonce: string | null;
let hydrate: Ref<unknown>;
/** Every `drafts.addAttachment` the server received, in order. */
let attachCalls: RowAttachment[];
/** When set, the next attach is held at the server's door until released. */
let holdNextAttach: Deferred<void> | null;
/** When set, the next attach lands but its answer never reaches the page (it reloaded). */
let loseNextAnswer: boolean;

function publish() {
	hydrate.value = row ? JSON.parse(JSON.stringify(row)) : null;
}

function serverAttach(args: RowAttachment & { draftId: string }) {
	const { draftId: _draftId, ...attachment } = args;
	attachCalls.push(attachment);
	// The repeat-is-done rule: an upload the draft already holds is not added again.
	if (!row!.attachments.some((a) => a.storageId === attachment.storageId)) {
		row!.attachments = [...row!.attachments, attachment];
	}
	publish();
	return { ok: true, result: { ok: true } };
}

const operations: Record<string, (args: never) => Promise<unknown>> = {
	'drafts.create': async (args: { requestNonce?: string }) => {
		if (row && args.requestNonce && args.requestNonce === rowNonce) {
			return { ok: true, result: { draftId: DRAFT, existing: true } };
		}
		row = {
			toAddresses: [],
			subject: '',
			bodyHtml: '',
			composerMode: 'simple',
			state: 'draft',
			lastEditedAt: Date.now(),
			attachments: [],
		};
		rowNonce = args.requestNonce ?? null;
		publish();
		return { ok: true, result: { draftId: DRAFT, toAddresses: [], subject: '' } };
	},
	'drafts.update': async (args: Partial<Row> & { draftId: string }) => {
		const { draftId: _draftId, ...fields } = args;
		row = { ...row!, ...fields, lastEditedAt: Date.now() };
		publish();
		return { ok: true, result: { savedAt: row.lastEditedAt } };
	},
	'storage.generateUploadUrl': async () => ({ ok: true, result: 'https://upload.example/u' }),
	'drafts.addAttachment': async (args: RowAttachment & { draftId: string }) => {
		const held = holdNextAttach;
		holdNextAttach = null;
		if (held) await held.promise;
		const lost = loseNextAnswer;
		loseNextAnswer = false;
		const answer = serverAttach(args);
		return lost ? new Promise(() => {}) : answer;
	},
};

// ── The composer: the real state machine behind the page's composer seam ────

type Compose = ReturnType<typeof usePostboxCompose>;
let composers: Compose[];
const current = () => composers[composers.length - 1]!;

const Composer = defineComponent({
	name: 'PostboxComposer',
	props: {
		seed: { type: Object, required: true },
		frame: { type: String, default: undefined },
		beforeReady: { type: Function, default: undefined },
		replyAllRecipients: { type: Array, default: undefined },
	},
	emits: ['sent', 'discarded', 'draft-id', 'saved', 'subject', 'minimize'],
	setup(props, { expose, emit }) {
		const compose = usePostboxCompose(props.seed as ComposeSpec, {
			beforeReady: props.beforeReady as never,
		});
		composers.push(compose);
		watch(compose.draftId, (id) => id && emit('draft-id', id), { immediate: true });
		watch(compose.lastSavedAt, (at) => at !== null && emit('saved'));
		expose({
			flush: compose.flush,
			parkable: compose.parkable,
			rescanMirror: () => compose.draftMirror.rescan(),
			onCreated: compose.onCreated,
		});
	},
	template: '<div data-testid="composer" />',
});

// ── The page around it ──────────────────────────────────────────────────────

let query: Record<string, string>;
let states: Record<string, unknown>;
const replace = vi.fn(async (_to: unknown) => {});
let rawEml: string | null;

enableAutoUnmount(afterEach);

beforeEach(() => {
	vi.useRealTimers();
	row = null;
	rowNonce = null;
	hydrate = ref(undefined);
	attachCalls = [];
	holdNextAttach = null;
	loseNextAnswer = false;
	puts.length = 0;
	composers = [];
	query = {};
	states = {};
	rawEml = null;
	replace.mockClear();
	window.sessionStorage.clear();
	window.history.replaceState({ back: '/dashboard/postbox/inbox' }, '');

	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', () => {});
	vi.stubGlobal(
		'navigateTo',
		vi.fn(async () => {})
	);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
	vi.stubGlobal('usePostboxComposeNav', usePostboxComposeNav);
	vi.stubGlobal('useRoute', () => ({ query }));
	vi.stubGlobal('useRouter', () => ({
		replace,
		back: vi.fn(),
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
	vi.stubGlobal('useConvexQuery', (fn: unknown) =>
		fn === 'drafts.get' ? { data: hydrate, error: ref(null) } : { data: ref(undefined) }
	);
	vi.stubGlobal('useBackendOperation', (fn: string) => ({
		run: vi.fn(async (args: never) =>
			operations[fn] ? operations[fn](args) : { ok: true, result: {} }
		),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'user-test' }) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvex', () => null);
	vi.stubGlobal(
		'loadRawEml',
		vi.fn(async () => rawEml)
	);
});

function mountPage() {
	return mount(ComposePage, {
		global: {
			plugins: [createTestI18n()],
			components: { PostboxComposer: Composer },
			stubs: { UiSkeleton: true, Icon: true, UiButton: true },
		},
	});
}

/** Open `spec` the way `nav.open` does and show it. */
function open(spec: Partial<ComposeSpec>): string {
	const key = usePostboxComposeNav().create({ mailboxId: 'mbx-1' as never, ...spec });
	query = { c: key };
	return key;
}

/** The URL the page last wrote (the one a reload comes back to). */
function lastUrl(): Record<string, string> {
	const target = replace.mock.calls.at(-1)![0] as { query: Record<string, string> };
	return target.query;
}

/** The tab reloads: memory is gone, sessionStorage and the URL stay. */
function reload(page: ReturnType<typeof mountPage>) {
	page.unmount();
	states = {};
	query = lastUrl();
	return mountPage();
}

const names = (list: { filename: string }[]) => list.map((a) => a.filename);

const RSVP: ComposeSpec = {
	mailboxId: 'mbx-1' as never,
	prefillTo: ['bob@example.com'],
	prefillSubject: 'Accepted: Quarterly planning',
	prefillBodyHtml: '<p>I accepted Quarterly planning.</p>',
	attachGenerated: {
		filename: 'reply.ics',
		contentType: 'text/calendar; method=REPLY; charset=utf-8',
		content: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR',
	},
};

/** Accept an invite; the text is saved and the URL names the draft while reply.ics uploads. */
async function acceptInvite() {
	const key = open(RSVP);
	const page = mountPage();
	await flushPromises();
	expect(names(puts.map((p) => ({ filename: p.file.name })))).toEqual(['reply.ics']);
	expect(lastUrl()).toEqual({ c: key, mailbox: 'mbx-1', draft: DRAFT });
	expect(row!.bodyHtml).toContain('Quarterly planning');
	expect(row!.attachments).toEqual([]);
	expect(current().canSend.value).toBe(false);
	return page;
}

describe('compose page — an expected attachment across a reload (#1257)', () => {
	it('uploads the RSVP again when the reload came before its upload finished', async () => {
		const page = await acceptInvite();

		const again = reload(page);
		await flushPromises();
		const composer = current();
		expect(composer.draftId.value).toBe(DRAFT);
		expect(composer.bodyHtml.value).toContain('Quarterly planning');
		// The reopened draft re-attaches reply.ics, and Send waits for it.
		expect(puts).toHaveLength(2);
		expect(names(composer.uploads.value)).toEqual(['reply.ics']);
		expect(composer.isUploading.value).toBe(true);
		expect(composer.canSend.value).toBe(false);

		puts[1]!.done.resolve('sid-2');
		await flushPromises();
		expect(names(row!.attachments)).toEqual(['reply.ics']);
		expect(names(composer.attachments.value)).toEqual(['reply.ics']);
		expect(composer.canSend.value).toBe(true);
		again.unmount();

		// Settled: a later reopen attaches nothing more.
		states = {};
		mountPage();
		await flushPromises();
		expect(puts).toHaveLength(2);
		expect(attachCalls).toHaveLength(1);
		expect(names(current().attachments.value)).toEqual(['reply.ics']);
		expect(current().canSend.value).toBe(true);
	});

	it('leaves one reply.ics when the attach in flight at the reload had landed', async () => {
		const page = await acceptInvite();
		// The attach lands, but the page reloads before its answer comes back.
		loseNextAnswer = true;
		puts[0]!.done.resolve('sid-1');
		await flushPromises();
		expect(names(row!.attachments)).toEqual(['reply.ics']);
		expect(names(current().attachments.value)).toEqual([]);

		reload(page);
		await flushPromises();
		expect(puts).toHaveLength(1);
		expect(attachCalls).toHaveLength(1);
		expect(names(current().attachments.value)).toEqual(['reply.ics']);
		expect(current().canSend.value).toBe(true);
	});

	it('leaves one reply.ics when that attach lands only after the reopened page looked', async () => {
		const page = await acceptInvite();
		holdNextAttach = deferred();
		const lateAttach = holdNextAttach;
		puts[0]!.done.resolve('sid-1');
		await flushPromises();

		reload(page);
		await flushPromises();
		// The reopened page found no reply.ics on the row, so it attached the
		// recorded upload again instead of uploading a second copy.
		expect(puts).toHaveLength(1);
		expect(attachCalls.map((a) => a.storageId)).toEqual(['sid-1']);
		expect(names(current().attachments.value)).toEqual(['reply.ics']);

		// Then the first attach reaches the server.
		lateAttach.resolve();
		await flushPromises();
		expect(attachCalls.map((a) => a.storageId)).toEqual(['sid-1', 'sid-1']);
		expect(names(row!.attachments)).toEqual(['reply.ics']);
		expect(names(current().attachments.value)).toEqual(['reply.ics']);
		expect(current().canSend.value).toBe(true);
	});

	it('re-copies only the forwarded file that had not reached the row', async () => {
		rawEml = [
			'From: carol@example.com',
			'Subject: Q3 numbers',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary="b1"',
			'',
			'--b1',
			'Content-Type: text/plain',
			'',
			'See attached.',
			'--b1',
			'Content-Type: application/pdf',
			'Content-Disposition: attachment; filename="numbers.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			'JVBERi0xLjQK',
			'--b1',
			'Content-Type: text/plain',
			'Content-Disposition: attachment; filename="notes.txt"',
			'',
			'remember the totals',
			'--b1--',
			'',
		].join('\r\n');
		const key = open({
			prefillTo: ['dave@example.com'],
			prefillSubject: 'Fwd: Q3 numbers',
			prefillBodyHtml: '<p>FYI</p>',
			forwardAttachmentsFromMessageId: 'msg-7' as never,
		});
		const page = mountPage();
		await flushPromises();
		expect(names(puts.map((p) => ({ filename: p.file.name })))).toEqual([
			'numbers.pdf',
			'notes.txt',
		]);
		expect(lastUrl()).toEqual({ c: key, mailbox: 'mbx-1', draft: DRAFT });
		puts[0]!.done.resolve('sid-pdf');
		await flushPromises();
		expect(names(row!.attachments)).toEqual(['numbers.pdf']);

		reload(page);
		await flushPromises();
		expect(puts).toHaveLength(3);
		expect(puts[2]!.file.name).toBe('notes.txt');
		expect(current().canSend.value).toBe(false);
		puts[2]!.done.resolve('sid-notes');
		await flushPromises();
		expect(names(row!.attachments)).toEqual(['numbers.pdf', 'notes.txt']);
		expect(names(current().attachments.value)).toEqual(['numbers.pdf', 'notes.txt']);
		expect(attachCalls).toHaveLength(2);
		expect(current().canSend.value).toBe(true);
	});

	it('lets the person drop an expected file: removing its chip is not undone by a reload', async () => {
		const page = await acceptInvite();
		const chip = current().uploads.value[0]!;
		current().cancelUpload(chip.id);
		await flushPromises();
		expect(current().canSend.value).toBe(true);

		reload(page);
		await flushPromises();
		expect(puts).toHaveLength(1);
		expect(current().uploads.value).toEqual([]);
		expect(current().canSend.value).toBe(true);
	});
});
