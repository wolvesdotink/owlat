// @vitest-environment happy-dom
/**
 * A clearsigned text body shows its signed block alone, and the signature
 * verdict stands only beside that block (issue #1311):
 *   - a text body over the 64 KiB inline threshold is loaded from storage and
 *     classified, so text after the block never renders;
 *   - an HTML alternative never renders under a text-part verdict;
 *   - while the stored text loads, nothing renders and no verdict is passed on;
 *   - the inline clearsigned body under the threshold renders as before.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import PostboxReaderMessage from '../PostboxReaderMessage.vue';
import PostboxSecurityBadge from '../PostboxSecurityBadge.vue';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const action = vi.fn();
const fetchMock = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('requireConvex', () => ({ action }));
	vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
	action.mockReset();
	fetchMock.mockReset();
});

/** A verdict on a row verified before the scope was recorded. */
const LEGACY: InboundSignatureInfo = {
	isSigned: true,
	isSignatureValid: true,
	signerFingerprint: 'AABBCCDD00112233AABBCCDD00112233AABBCCDD',
	keySource: 'wkd',
};
const VERIFIED: InboundSignatureInfo = { ...LEGACY, scope: 'clearsigned' };
const VERIFIED_MIME: InboundSignatureInfo = { ...LEGACY, scope: 'mime' };
/** A `.asc` attachment that has nothing to do with the clearsigned body. */
const ASC_ATTACHMENT = {
	filename: 'old.asc',
	contentType: 'application/pgp-signature',
	size: 833,
	partIndex: '2',
};

const SIGNED_BLOCK = [
	'-----BEGIN PGP SIGNED MESSAGE-----',
	'Hash: SHA256',
	'',
	'Please pay invoice 4471 to the usual account.',
	'-----BEGIN PGP SIGNATURE-----',
	'',
	'iQEzBAEBCAAdFiEEqrvM3QARIjOqu8zdABEiM6q7zN0FAmcAAAA=',
	'=abcd',
	'-----END PGP SIGNATURE-----',
].join('\n');
const UNSIGNED_TAIL = 'UNSIGNED TAIL: the account changed, use 999 instead.';
/** Over the inline threshold, so ingest stored it as a blob. */
const LARGE_TEXT = `${SIGNED_BLOCK}\n\n${UNSIGNED_TAIL}\n${'filler line\n'.repeat(6000)}`;

/** Records the verdict and class the trust chip is handed. */
const TrustChipMarker = defineComponent({
	name: 'PostboxTrustChip',
	props: ['signature', 'secureClass', 'showSecurityDetail'],
	setup: (p) => () =>
		h('div', {
			'data-testid': 'trust-chip',
			'data-signature': p['signature'] ? 'present' : 'absent',
			'data-secure-class': p['secureClass'],
		}),
});
const marker = (name: string) =>
	defineComponent({ name, setup: () => () => h('div', { 'data-testid': name }) });
const passThrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.()),
	});

const base = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	fromAddress: 'jonas@example.com',
	fromName: 'Jonas Berg',
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	subject: 'Invoice 4471',
	receivedAt: Date.UTC(2026, 9, 6, 9, 14),
	hasAttachments: false,
	attachments: [],
};

function mountCard(
	message: Record<string, unknown>,
	opts: { secureClass?: string; hideBody?: boolean; expanded?: boolean } = {}
) {
	return mount(PostboxReaderMessage, {
		props: {
			message: { ...base, ...message } as never,
			mailboxId: 'mbx_1',
			expanded: opts.expanded ?? true,
			relativeTime: '2h',
			starred: false,
			showReplyAll: false,
			showSenderControls: true,
			authEnabled: true,
			sealedEnabled: false,
			secureClass: (opts.secureClass ?? 'none') as never,
			hideBody: opts.hideBody ?? false,
			showRenderToggle: false,
			forcedLight: false,
			imagesAllowed: false,
			hasInvite: false,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				UiAvatar: marker('UiAvatar'),
				PostboxTrustChip: TrustChipMarker,
				PostboxUnsubscribeChip: marker('PostboxUnsubscribeChip'),
				PostboxMessageDetails: marker('PostboxMessageDetails'),
				PostboxReaderMessageActions: marker('PostboxReaderMessageActions'),
				PostboxLazyBody: passThrough('PostboxLazyBody'),
				PostboxMessageBody: marker('PostboxMessageBody'),
				PostboxSecurityBadge,
				PostboxReaderSkeleton: marker('PostboxReaderSkeleton'),
				PostboxInviteCard: marker('PostboxInviteCard'),
				PostboxMessageAttachments: marker('PostboxMessageAttachments'),
				PostboxSchedulingChip: marker('PostboxSchedulingChip'),
				PostboxDeliveryStrip: marker('PostboxDeliveryStrip'),
			},
			stubs: { Icon: true },
		},
	});
}

type Card = ReturnType<typeof mountCard>;
const has = (w: Card, id: string) => w.find(`[data-testid="${id}"]`).exists();
const chip = (w: Card) => w.get('[data-testid="trust-chip"]');

/** The blob-URL action answers with these URLs; the text URL serves `text`. */
function storeBodies(text: string, urls: { htmlUrl?: string } = {}) {
	action.mockResolvedValue({
		htmlUrl: urls.htmlUrl ?? null,
		textUrl: 'https://blob.example.com/t',
	});
	fetchMock.mockImplementation(async (url: string) => ({
		ok: true,
		text: async () => (url === 'https://blob.example.com/t' ? text : '<p>UNSIGNED HTML</p>'),
	}));
}

describe('PostboxReaderMessage · clearsigned text bound to its verdict', () => {
	it('a stored text body over 64 KiB shows only the signed block, beside the verdict', async () => {
		expect(new TextEncoder().encode(LARGE_TEXT).byteLength).toBeGreaterThan(64 * 1024);
		storeBodies(LARGE_TEXT);
		const w = mountCard({ textBodyStorageId: 'blob_t', inboundSignatureInfo: VERIFIED });
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(false);
		expect(w.get('[data-testid="clearsigned-text"]').text()).toBe(
			'Please pay invoice 4471 to the usual account.'
		);
		expect(w.text()).not.toContain('UNSIGNED TAIL');
		expect(w.text()).not.toContain('filler line');
		expect(w.get('[data-testid="signature-badge-summary"]').text()).toBe('Signed · verified');
		expect(w.get('[data-testid="clearsigned-omitted"]').text()).toBe(
			'Only the signed part is shown. The rest of this message is not covered by the signature.'
		);
		expect(chip(w).attributes('data-signature')).toBe('present');
		expect(chip(w).attributes('data-secure-class')).toBe('pgp-clearsigned');
	});

	it('never renders an inline HTML alternative under a text-part verdict', async () => {
		storeBodies(SIGNED_BLOCK);
		const w = mountCard({
			htmlBodyInline: '<p>UNSIGNED HTML</p>',
			textBodyStorageId: 'blob_t',
			inboundSignatureInfo: VERIFIED,
		});
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(false);
		expect(w.text()).not.toContain('UNSIGNED HTML');
		expect(w.get('[data-testid="clearsigned-text"]').text()).toBe(
			'Please pay invoice 4471 to the usual account.'
		);
		// The HTML part exists and is left out, so the card says so.
		expect(has(w, 'clearsigned-omitted')).toBe(true);
	});

	it('loads the text blob, not the HTML one, when both bodies are stored', async () => {
		storeBodies(SIGNED_BLOCK, { htmlUrl: 'https://blob.example.com/h' });
		const w = mountCard({
			htmlBodyStorageId: 'blob_h',
			textBodyStorageId: 'blob_t',
			inboundSignatureInfo: VERIFIED,
		});
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith('https://blob.example.com/t');
		expect(has(w, 'PostboxMessageBody')).toBe(false);
		expect(w.text()).not.toContain('UNSIGNED HTML');
		expect(has(w, 'clearsigned-omitted')).toBe(true);
	});

	it('renders nothing and passes no verdict on while the stored text loads', async () => {
		action.mockReturnValue(new Promise(() => {}));
		const w = mountCard({ textBodyStorageId: 'blob_t', inboundSignatureInfo: VERIFIED });
		await flushPromises();

		const loading = w.get('[data-testid="signed-body-loading"]');
		expect(loading.attributes('aria-busy')).toBe('true');
		expect(loading.get('[role="status"]').text()).toBe('Loading the signed text…');
		expect(has(w, 'PostboxMessageBody')).toBe(false);
		expect(has(w, 'signature-badge')).toBe(false);
		expect(chip(w).attributes('data-signature')).toBe('absent');
		expect(chip(w).attributes('data-secure-class')).toBe('none');
	});

	it('waits for the inline body query without a fetch of its own', async () => {
		const w = mountCard({ bodyPending: true, inboundSignatureInfo: VERIFIED });
		await flushPromises();

		expect(action).not.toHaveBeenCalled();
		expect(has(w, 'signed-body-loading')).toBe(true);
		expect(chip(w).attributes('data-signature')).toBe('absent');

		await w.setProps({
			message: { ...base, textBodyInline: SIGNED_BLOCK, inboundSignatureInfo: VERIFIED } as never,
		});
		expect(w.get('[data-testid="clearsigned-text"]').text()).toBe(
			'Please pay invoice 4471 to the usual account.'
		);
		expect(chip(w).attributes('data-signature')).toBe('present');
	});

	it('leaves the inline clearsigned body under the threshold as it was', async () => {
		const w = mountCard(
			{ textBodyInline: SIGNED_BLOCK, inboundSignatureInfo: VERIFIED },
			{ secureClass: 'pgp-clearsigned', hideBody: true }
		);
		await flushPromises();

		expect(action).not.toHaveBeenCalled();
		expect(has(w, 'PostboxMessageBody')).toBe(false);
		// Selected as main rendered it, so this case also passes without the fix.
		expect(w.get('pre').text()).toBe('Please pay invoice 4471 to the usual account.');
		expect(w.get('[data-testid="signature-badge-summary"]').text()).toBe('Signed · verified');
		expect(has(w, 'clearsigned-omitted')).toBe(false);
		expect(chip(w).attributes('data-signature')).toBe('present');
	});

	it('says so when an inline body holds text outside the signed block', async () => {
		const w = mountCard(
			{ textBodyInline: `${SIGNED_BLOCK}\n${UNSIGNED_TAIL}`, inboundSignatureInfo: VERIFIED },
			{ secureClass: 'pgp-clearsigned', hideBody: true }
		);
		await flushPromises();

		expect(w.text()).not.toContain('UNSIGNED TAIL');
		expect(has(w, 'clearsigned-omitted')).toBe(true);
	});

	it('drops a verdict it cannot tie to a signed block, and renders the body', async () => {
		storeBodies('Just a long plain body.\n'.repeat(4000));
		const w = mountCard({ textBodyStorageId: 'blob_t', inboundSignatureInfo: VERIFIED });
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(true);
		expect(has(w, 'signature-badge')).toBe(false);
		expect(chip(w).attributes('data-signature')).toBe('absent');
	});

	it('shows the note when the signed block holds only whitespace', async () => {
		const blank = SIGNED_BLOCK.replace('Please pay invoice 4471 to the usual account.', '   ');
		const w = mountCard(
			{
				textBodyInline: blank,
				htmlBodyInline: '<p>UNSIGNED HTML</p>',
				inboundSignatureInfo: VERIFIED,
			},
			{ secureClass: 'pgp-clearsigned', hideBody: true }
		);
		await flushPromises();

		expect(w.get('[data-testid="clearsigned-text"]').text()).toBe('');
		expect(has(w, 'clearsigned-omitted')).toBe(true);
		expect(w.text()).not.toContain('UNSIGNED HTML');
	});

	it('leaves PGP/MIME and unsigned mail alone', async () => {
		const mime = mountCard(
			{ textBodyStorageId: 'blob_t', inboundSignatureInfo: VERIFIED_MIME },
			{ secureClass: 'pgp-signed' }
		);
		const plain = mountCard({ textBodyStorageId: 'blob_t' });
		const collapsed = mountCard(
			{ textBodyStorageId: 'blob_t', inboundSignatureInfo: VERIFIED },
			{ expanded: false }
		);
		await flushPromises();

		expect(action).not.toHaveBeenCalled();
		expect(has(mime, 'PostboxMessageBody')).toBe(true);
		expect(chip(mime).attributes('data-signature')).toBe('present');
		expect(has(plain, 'PostboxMessageBody')).toBe(true);
		expect(collapsed.find('[data-testid="trust-chip"]').exists()).toBe(false);
	});
});

describe('PostboxReaderMessage · the verdict scope, not the attachment list, decides', () => {
	it('a clearsigned verdict beside an unrelated .asc attachment still shows only the block', async () => {
		storeBodies(`${SIGNED_BLOCK}\n${UNSIGNED_TAIL}`);
		const w = mountCard(
			{
				htmlBodyInline: '<p>UNSIGNED HTML</p>',
				textBodyStorageId: 'blob_t',
				attachments: [ASC_ATTACHMENT],
				hasAttachments: true,
				inboundSignatureInfo: VERIFIED,
			},
			{ secureClass: 'pgp-signed' }
		);
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(false);
		expect(w.text()).not.toContain('UNSIGNED');
		expect(w.get('[data-testid="clearsigned-text"]').text()).toBe(
			'Please pay invoice 4471 to the usual account.'
		);
		expect(chip(w).attributes('data-secure-class')).toBe('pgp-clearsigned');
		expect(chip(w).attributes('data-signature')).toBe('present');
	});

	it('a MIME verdict with a nameless signature part keeps its verdict and body', async () => {
		// No attachment metadata, so the host classifies the message as unsigned.
		const w = mountCard({ textBodyStorageId: 'blob_t', inboundSignatureInfo: VERIFIED_MIME });
		await flushPromises();

		expect(action).not.toHaveBeenCalled();
		expect(has(w, 'PostboxMessageBody')).toBe(true);
		expect(chip(w).attributes('data-signature')).toBe('present');
	});

	it('an older row whose .asc attachment disagrees with its text withholds the verdict', async () => {
		storeBodies(SIGNED_BLOCK);
		const w = mountCard(
			{
				htmlBodyInline: '<p>UNSIGNED HTML</p>',
				textBodyStorageId: 'blob_t',
				attachments: [ASC_ATTACHMENT],
				hasAttachments: true,
				inboundSignatureInfo: LEGACY,
			},
			{ secureClass: 'pgp-signed' }
		);
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(true);
		expect(chip(w).attributes('data-signature')).toBe('absent');
	});

	it('an older PGP/MIME row keeps its verdict once its text shows no clearsigned block', async () => {
		storeBodies('Ordinary signed text.\n'.repeat(4000));
		const w = mountCard(
			{
				textBodyStorageId: 'blob_t',
				attachments: [ASC_ATTACHMENT],
				hasAttachments: true,
				inboundSignatureInfo: LEGACY,
			},
			{ secureClass: 'pgp-signed' }
		);
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(true);
		expect(chip(w).attributes('data-signature')).toBe('present');
	});

	it('an older clearsigned row without a scope still shows only its block', async () => {
		storeBodies(LARGE_TEXT);
		const w = mountCard({ textBodyStorageId: 'blob_t', inboundSignatureInfo: LEGACY });
		await flushPromises();

		expect(has(w, 'PostboxMessageBody')).toBe(false);
		expect(w.text()).not.toContain('UNSIGNED TAIL');
		expect(chip(w).attributes('data-signature')).toBe('present');
	});
});
