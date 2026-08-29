// @vitest-environment happy-dom
/**
 * The share-link revocation list (idea 10).
 *
 * A link handed to a stranger inside a draft is only safe if it can be found
 * again and taken back, so the card is judged on what it offers per row rather
 * than on how it looks:
 *
 *   - it shows dead links too, because "the download stopped working" is the
 *     question people arrive with;
 *   - "copy" appears only where the SERVER handed back a URL — a copy button
 *     for a link the route would refuse is a support ticket;
 *   - revoke deletes the file, so it is confirmed; narrowing does not, so it
 *     is one click;
 *   - once the public URL is gone the owner still gets a way into their own
 *     file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PostboxSharedLinksSettings from '../PostboxSharedLinksSettings.vue';
import { usePostboxAttachmentShares } from '~/composables/postbox/usePostboxAttachmentShares';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			attachmentShares: {
				list: 'attachmentShares.list',
				revoke: 'attachmentShares.revoke',
				setScope: 'attachmentShares.setScope',
				downloadUrl: 'attachmentShares.downloadUrl',
			},
		},
	},
}));

type Row = {
	_id: string;
	filename: string;
	size: number;
	scope: 'anyone' | 'mailbox';
	state: 'live' | 'revoked' | 'expired';
	publicUrl: string | null;
	hasBytes: boolean;
	downloadCount: number;
};

const revoke = vi.fn(async () => ({ ok: true, result: {} }));
const setScope = vi.fn(async () => ({ ok: true, result: {} }));
const downloadUrl = vi.fn(async () => 'https://deploy.convex.cloud/blob/1');
let rows: Row[];

const LIVE: Row = {
	_id: 'sh-live',
	filename: 'quarterly-review.pdf',
	size: 24_000_000,
	scope: 'anyone',
	state: 'live',
	publicUrl: 'https://deploy.convex.site/attachment-share/abc',
	hasBytes: true,
	downloadCount: 3,
};
const NARROWED: Row = {
	_id: 'sh-narrow',
	filename: 'salaries.xlsx',
	size: 12_000,
	scope: 'mailbox',
	state: 'live',
	publicUrl: null,
	hasBytes: true,
	downloadCount: 0,
};
const EXPIRED: Row = {
	_id: 'sh-expired',
	filename: 'old-deck.key',
	size: 900,
	scope: 'anyone',
	state: 'expired',
	publicUrl: null,
	hasBytes: false,
	downloadCount: 41,
};

beforeEach(() => {
	rows = [LIVE, NARROWED, EXPIRED];
	revoke.mockClear();
	setScope.mockClear();
	downloadUrl.mockClear();

	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxMailbox', () => ({ currentMailbox: ref({ _id: 'mbx-1' }) }));
	vi.stubGlobal('useConvexQuery', () => ({ data: computed(() => rows), isLoading: ref(false) }));
	vi.stubGlobal('requireConvex', () => ({ query: downloadUrl }));
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(), isCopied: () => false }));
	vi.stubGlobal('formatCompactFileSize', (bytes: number) => `${bytes} B`);
	vi.stubGlobal('usePostboxSettings', () => ({
		shareLinkExpiryDays: ref(14),
		setShareLinkExpiryDays: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', (fn: unknown) => ({
		run: fn === 'attachmentShares.revoke' ? revoke : setScope,
		isLoading: ref(false),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	// The REAL composable over the stubbed Convex layers: the point of these
	// cases is what the card does with the rows the server projected, and a
	// hand-written stand-in for the composable would test the stand-in.
	vi.stubGlobal('usePostboxAttachmentShares', usePostboxAttachmentShares);
	windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
});

let windowOpen: ReturnType<typeof vi.spyOn>;

function mountCard() {
	return mount(PostboxSharedLinksSettings, {
		global: {
			plugins: [createTestI18n()],
			// Nuxt resolves this auto-import inside the template, where a plain
			// global is out of scope.
			mocks: { formatCompactFileSize: (bytes: number) => `${bytes} B` },
			stubs: {
				UiConfirmationDialog: {
					props: ['open'],
					emits: ['confirm'],
					template: '<div class="dialog" :data-open="open" @click="$emit(\'confirm\')" />',
				},
			},
		},
	});
}

describe('PostboxSharedLinksSettings', () => {
	it('lists dead links beside live ones, fully localized', () => {
		const card = mountCard();
		const html = card.html();
		expect(html).toContain('quarterly-review.pdf');
		expect(html).toContain('salaries.xlsx');
		// The expired one is the whole reason anyone opens this card.
		expect(html).toContain('old-deck.key');
		expectFullyLocalized(card);
	});

	it('hides itself entirely until something has been shared', () => {
		rows = [];
		expect(mountCard().find('#shared-links').exists()).toBe(false);
	});

	it('offers a copy button only for the rows the server gave a URL', () => {
		const rowEls = mountCard().findAll('li');
		const copyButtons = rowEls.map((li) =>
			li.findAll('button').some((b) => b.text() === 'Copy link')
		);
		expect(copyButtons).toEqual([true, false, false]);
	});

	it('narrows a link to the mailbox in one click, with no confirmation', async () => {
		const card = mountCard();
		const limit = card.findAll('button').find((b) => b.text() === 'Limit to my mailbox');
		await limit!.trigger('click');

		expect(setScope).toHaveBeenCalledWith({ shareId: 'sh-live', scope: 'mailbox' });
		expect(card.find('.dialog').attributes('data-open')).toBe('false');
	});

	it('confirms before a revoke, because a revoke deletes the file', async () => {
		const card = mountCard();
		const revokeButton = card.findAll('button').find((b) => b.text() === 'Revoke');
		await revokeButton!.trigger('click');

		// Nothing has happened yet — the dialog is the gate.
		expect(revoke).not.toHaveBeenCalled();
		expect(card.find('.dialog').attributes('data-open')).toBe('true');

		await card.find('.dialog').trigger('click');
		expect(revoke).toHaveBeenCalledWith({ shareId: 'sh-live' });
	});

	it('keeps an owner-side way into a file whose public link was narrowed away', async () => {
		const card = mountCard();
		const openButtons = card.findAll('button').filter((b) => b.text() === 'Open');
		// Exactly the narrowed row: the live one still has its public URL, and the
		// expired one has no bytes left to open.
		expect(openButtons).toHaveLength(1);

		await openButtons[0]!.trigger('click');
		expect(downloadUrl).toHaveBeenCalledWith('attachmentShares.downloadUrl', {
			shareId: 'sh-narrow',
		});
		await Promise.resolve();
		expect(windowOpen).toHaveBeenCalledWith(
			'https://deploy.convex.cloud/blob/1',
			'_blank',
			'noopener,noreferrer'
		);
	});
});
