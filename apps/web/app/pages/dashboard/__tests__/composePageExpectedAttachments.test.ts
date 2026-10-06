// @vitest-environment happy-dom
/**
 * #1257: a file the open asked for (an RSVP's generated `reply.ics`, a
 * forward's attachments) that is not on the draft yet when the page reloads,
 * or when the draft is open in a second tab.
 *
 * The draft row owes such files until they are attached, so these cases run
 * the real compose page, the real compose request and the real composer
 * (`usePostboxCompose`) against a small in-memory server that keeps that debt
 * the way `mail/draftExpectedAttachments.ts` does: written with the row, each
 * key attached once (`fulfil`), removed for good (`remove`). A tab is a page
 * mount with its own session state; a reload unmounts the page and drops it.
 *
 *   - the RSVP still being copied at the reload is attached after it, and Send
 *     waits for it;
 *   - a second tab with no compose request at all sees the same debt, and two
 *     tabs asking at once leave one `reply.ics`;
 *   - a forwarded file that cannot be read stays owed, with Retry;
 *   - removing the chip while its copy is in flight keeps it out.
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
			draftExpectedAttachments: { fulfil: 'expected.fulfil', remove: 'expected.remove' },
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

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// ── The server: one draft row and the files it owes ────────────────────────

interface Owed {
	key: string;
	filename: string;
	contentType: string;
	size: number;
	source: { kind: 'generated'; content?: string } | { kind: 'forward'; messageId: string };
	state: 'owed' | 'attached' | 'removed';
	storageId?: string;
}
interface Row {
	toAddresses: string[];
	subject: string;
	bodyHtml: string;
	composerMode: 'simple';
	state: 'draft';
	lastEditedAt: number;
	attachments: { storageId: string; filename: string; contentType: string; size: number }[];
	expectedAttachments?: Owed[];
}
const DRAFT = 'draft-1';
const FORWARDED = {
	'msg-7': [
		{ filename: 'numbers.pdf', contentType: 'application/pdf', size: 12 },
		{ filename: 'logo.png', contentType: 'image/png', size: 4, contentId: 'logo@x' },
	],
};
let row: Row | null;
let rowNonce: string | null;
let hydrate: Ref<unknown>;
let blobs: number;
/** Every `fulfil` the server received, in order. */
let fulfils: number;
/** Held `fulfil` calls: each waits at the server's door until released. */
let holdFulfil: Deferred[];
let forwardReadable: boolean;

function publish() {
	// `drafts.get` leaves a generated file's text on the server.
	hydrate.value = row
		? JSON.parse(
				JSON.stringify({
					...row,
					expectedAttachments: row.expectedAttachments?.map((e) =>
						e.source.kind === 'generated' ? { ...e, source: { kind: 'generated' } } : e
					),
				})
			)
		: null;
}

function owedFor(requests: Array<Record<string, unknown>>): Owed[] {
	return requests.flatMap((request, index): Owed[] => {
		if (request['kind'] === 'generated') {
			const content = request['content'] as string;
			return [
				{
					key: `generated:${index}`,
					filename: request['filename'] as string,
					contentType: request['contentType'] as string,
					size: content.length,
					source: { kind: 'generated', content },
					state: 'owed',
				},
			];
		}
		const messageId = request['messageId'] as keyof typeof FORWARDED;
		return FORWARDED[messageId]
			.filter((part) => !('contentId' in part))
			.map((part, i) => ({
				key: `forward:${messageId}:${i}`,
				filename: part.filename,
				contentType: part.contentType,
				size: part.size,
				source: { kind: 'forward', messageId },
				state: 'owed',
			}));
	});
}

const operations: Record<string, (args: never) => Promise<unknown>> = {
	'drafts.create': async (args: {
		requestNonce?: string;
		expectedAttachments?: Array<Record<string, unknown>>;
	}) => {
		if (row && args.requestNonce && args.requestNonce === rowNonce) {
			return { ok: true, result: { draftId: DRAFT, existing: true } };
		}
		const owed = owedFor(args.expectedAttachments ?? []);
		row = {
			toAddresses: [],
			subject: '',
			bodyHtml: '',
			composerMode: 'simple',
			state: 'draft',
			lastEditedAt: Date.now(),
			attachments: [],
			...(owed.length ? { expectedAttachments: owed } : {}),
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
	'expected.fulfil': async () => {
		fulfils += 1;
		const gate = holdFulfil.shift();
		if (gate) await gate.promise;
		const failed = [];
		for (const entry of row!.expectedAttachments ?? []) {
			// Settled meanwhile (another tab, a removal): this copy is dropped.
			if (entry.state !== 'owed') continue;
			if (entry.source.kind === 'forward' && !forwardReadable) {
				failed.push({ key: entry.key, filename: entry.filename, reason: 'unreadable' });
				continue;
			}
			blobs += 1;
			const storageId = `blob-${blobs}`;
			const { filename, contentType, size } = entry;
			row!.attachments = [...row!.attachments, { storageId, filename, contentType, size }];
			entry.state = 'attached';
			entry.storageId = storageId;
		}
		publish();
		return { ok: true, result: { failed } };
	},
	'expected.remove': async (args: { key: string }) => {
		const entry = row!.expectedAttachments!.find((e) => e.key === args.key)!;
		row!.attachments = row!.attachments.filter((a) => a.storageId !== entry.storageId);
		entry.state = 'removed';
		publish();
		return { ok: true, result: { ok: true } };
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
const showToast = vi.fn();

enableAutoUnmount(afterEach);

beforeEach(() => {
	row = null;
	rowNonce = null;
	hydrate = ref(undefined);
	blobs = 0;
	fulfils = 0;
	holdFulfil = [];
	forwardReadable = true;
	composers = [];
	query = {};
	states = {};
	replace.mockClear();
	showToast.mockClear();
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
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConvex', () => null);
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

/** The tab reloads: its memory is gone; sessionStorage and the URL stay. */
function reload(page: ReturnType<typeof mountPage>) {
	page.unmount();
	states = {};
	query = lastUrl();
	return mountPage();
}

/** Another tab opens the draft's URL: no memory and none of this tab's storage. */
function secondTab() {
	states = {};
	window.sessionStorage.clear();
	query = { c: 'a0b1c2d3e4f5a6b7c8d9e0f1', mailbox: 'mbx-1', draft: DRAFT };
	return mountPage();
}

const names = (list: { filename: string }[]) => list.map((a) => a.filename);

const RSVP: Partial<ComposeSpec> = {
	prefillTo: ['bob@example.com'],
	prefillSubject: 'Accepted: Quarterly planning',
	prefillBodyHtml: '<p>I accepted Quarterly planning.</p>',
	attachGenerated: {
		filename: 'reply.ics',
		contentType: 'text/calendar; method=REPLY; charset=utf-8',
		content: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR',
	},
};

/** Accept an invite while the server is slow to copy reply.ics on. */
async function acceptInvite() {
	const first = deferred();
	holdFulfil.push(first);
	const key = open(RSVP);
	const page = mountPage();
	await flushPromises();
	// The row owes reply.ics from the moment it exists, and the composer asked for it.
	expect(row!.expectedAttachments?.map((e) => [e.filename, e.state])).toEqual([
		['reply.ics', 'owed'],
	]);
	expect(fulfils).toBe(1);
	// The text is saved and the URL names the draft; reply.ics is still on its way.
	expect(lastUrl()).toEqual({ c: key, mailbox: 'mbx-1', draft: DRAFT });
	expect(row!.bodyHtml).toContain('Quarterly planning');
	expect(names(current().uploads.value)).toEqual(['reply.ics']);
	expect(current().canSend.value).toBe(false);
	return { page, first };
}

describe('compose page — files the draft owes, across reloads and tabs (#1257)', () => {
	it('attaches the RSVP after a reload that came before it was on the draft', async () => {
		const { page, first } = await acceptInvite();

		reload(page);
		await flushPromises();
		const composer = current();
		expect(composer.draftId.value).toBe(DRAFT);
		expect(composer.bodyHtml.value).toContain('Quarterly planning');
		// The reopened draft asked again; the server put reply.ics on.
		expect(fulfils).toBe(2);
		expect(names(composer.attachments.value)).toEqual(['reply.ics']);
		expect(composer.uploads.value).toEqual([]);
		expect(composer.canSend.value).toBe(true);

		// The first tab's request, still in flight, lands on a settled key.
		first.resolve();
		await flushPromises();
		expect(names(row!.attachments)).toEqual(['reply.ics']);
		expect(blobs).toBe(1);
	});

	it('shows a second tab the same debt, and two tabs asking leave one reply.ics', async () => {
		const { first } = await acceptInvite();
		const tabA = current();

		// Tab B has no compose request and no storage: only the URL and the row.
		const second = deferred();
		holdFulfil.push(second);
		secondTab();
		await flushPromises();
		const tabB = current();
		expect(tabB).not.toBe(tabA);
		expect(names(tabB.uploads.value)).toEqual(['reply.ics']);
		expect(tabB.canSend.value).toBe(false);

		second.resolve();
		await flushPromises();
		first.resolve();
		await flushPromises();
		expect(names(row!.attachments)).toEqual(['reply.ics']);
		expect(blobs).toBe(1);
		// Both tabs show the one copy, and both may send.
		for (const tab of [tabA, tabB]) {
			expect(names(tab.attachments.value)).toEqual(['reply.ics']);
			expect(tab.uploads.value).toEqual([]);
			expect(tab.canSend.value).toBe(true);
		}
	});

	it('keeps a forwarded file owed while it cannot be read, with Retry', async () => {
		forwardReadable = false;
		open({
			prefillTo: ['dave@example.com'],
			prefillSubject: 'Fwd: Q3 numbers',
			prefillBodyHtml: '<p>FYI</p>',
			forwardAttachmentsFromMessageId: 'msg-7' as never,
		});
		const page = mountPage();
		await flushPromises();
		// Only the file part is owed, not the inline logo.
		expect(row!.expectedAttachments?.map((e) => e.filename)).toEqual(['numbers.pdf']);
		expect(current().uploads.value.map((c) => [c.filename, c.status])).toEqual([
			['numbers.pdf', 'failed'],
		]);
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('numbers.pdf'), 'error');
		expect(current().canSend.value).toBe(false);

		// A reload while it is still unreadable keeps it owed.
		reload(page);
		await flushPromises();
		expect(current().uploads.value.map((c) => c.status)).toEqual(['failed']);
		expect(current().canSend.value).toBe(false);

		forwardReadable = true;
		current().retryUpload(current().uploads.value[0]!.id);
		await flushPromises();
		expect(names(current().attachments.value)).toEqual(['numbers.pdf']);
		expect(current().canSend.value).toBe(true);
	});

	it('keeps a file out once its chip is removed, even when its copy was in flight', async () => {
		const { page, first } = await acceptInvite();
		current().cancelUpload(current().uploads.value[0]!.id);
		await flushPromises();
		expect(row!.expectedAttachments?.[0]?.state).toBe('removed');
		expect(current().uploads.value).toEqual([]);
		expect(current().canSend.value).toBe(true);

		first.resolve();
		await flushPromises();
		expect(row!.attachments).toEqual([]);
		expect(current().attachments.value).toEqual([]);

		reload(page);
		await flushPromises();
		expect(current().attachments.value).toEqual([]);
		expect(current().canSend.value).toBe(true);
	});
});
