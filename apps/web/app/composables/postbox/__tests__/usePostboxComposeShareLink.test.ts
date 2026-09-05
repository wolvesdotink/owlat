/**
 * "Share as link instead" — the composer half of idea 10.
 *
 * The swap is destructive in one direction: a file leaves the message, and the
 * only thing left pointing at it is a block of HTML in the body. So the two
 * halves have to move together or not at all, and that is what this file
 * pins down:
 *
 *   - a share the server accepted detaches the chip AND appends the block;
 *   - a file the malware scan refused changes NOTHING — the attachment is still
 *     on the draft, the body is untouched, and the user is told why. A silently
 *     vanished attachment is far worse than a bounce at send time;
 *   - a failed call (offline, no draft) is likewise a no-op on both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';
import { formatCompactFileSize, formatDate } from '~/utils/formatters';

const i18n = createTestI18n();

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mail: {
			drafts: {
				addAttachment: 'drafts.addAttachment',
				removeAttachment: 'drafts.removeAttachment',
			},
			attachmentSharesActions: {
				shareDraftAttachment: 'attachmentSharesActions.shareDraftAttachment',
			},
		},
	},
}));

/** What `attachmentSharesActions.shareDraftAttachment` answers this run. */
let shareOutcome: { ok: boolean; result?: unknown };
const showToast = vi.fn();

beforeEach(() => {
	showToast.mockClear();
	shareOutcome = {
		ok: true,
		result: {
			ok: true,
			shareId: 'sh-1',
			url: 'https://deploy.convex.site/attachment-share/abc',
			filename: 'quarterly-review.pdf',
			size: 24_000_000,
			expiresAt: Date.UTC(2026, 2, 12),
			scanVerdict: 'clean',
		},
	};

	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConvex', () => null);
	vi.stubGlobal('usePostboxPendingAttachments', () => ({ take: () => null }));
	// Nuxt auto-imports these into the composable; the real ones, so the block's
	// meta line is the string a recipient would actually read.
	vi.stubGlobal('formatCompactFileSize', formatCompactFileSize);
	vi.stubGlobal('formatDate', formatDate);
	vi.stubGlobal('useBackendOperation', (fn: unknown) => ({
		run: vi.fn(async () =>
			fn === 'attachmentSharesActions.shareDraftAttachment'
				? shareOutcome
				: { ok: true, result: { ok: true } }
		),
		isLoading: ref(false),
	}));
});

async function makeAttachments(bodyHtml = ref('<p>Numbers attached.</p>')) {
	const { usePostboxComposeAttachments } = await import('../usePostboxComposeAttachments');
	const composable = withSetup(() =>
		usePostboxComposeAttachments({
			ensureDraft: async () => 'd1' as never,
			draftId: ref('d1' as never),
			bodyHtml,
		})
	).result;
	composable.attachments.value = [
		{
			storageId: 'st-1',
			filename: 'quarterly-review.pdf',
			contentType: 'application/pdf',
			size: 24_000_000,
		},
	];
	return { composable, bodyHtml };
}

describe('usePostboxComposeAttachments — share as link instead', () => {
	it('detaches the chip and appends the link block in one move', async () => {
		const { composable, bodyHtml } = await makeAttachments();

		await expect(composable.shareAsLink('st-1')).resolves.toBe(true);

		expect(composable.attachments.value).toHaveLength(0);
		expect(bodyHtml.value).toContain('<p>Numbers attached.</p>');
		expect(bodyHtml.value).toContain('href="https://deploy.convex.site/attachment-share/abc"');
		expect(bodyHtml.value).toContain('quarterly-review.pdf');
	});

	it('keeps the attachment and the body untouched when the scan refuses the file', async () => {
		shareOutcome = {
			ok: true,
			result: {
				ok: false,
				reason: 'infected',
				filename: 'quarterly-review.pdf',
				detail: 'Eicar-Test-Signature',
			},
		};
		const { composable, bodyHtml } = await makeAttachments();
		const before = bodyHtml.value;

		await expect(composable.shareAsLink('st-1')).resolves.toBe(false);

		expect(composable.attachments.value).toHaveLength(1);
		expect(bodyHtml.value).toBe(before);
		// Told, not silently dropped.
		expect(showToast).toHaveBeenCalledWith(
			expect.stringContaining('quarterly-review.pdf'),
			'error'
		);
	});

	it('changes nothing when the call itself fails', async () => {
		shareOutcome = { ok: false };
		const { composable, bodyHtml } = await makeAttachments();
		const before = bodyHtml.value;

		await expect(composable.shareAsLink('st-1')).resolves.toBe(false);

		expect(composable.attachments.value).toHaveLength(1);
		expect(bodyHtml.value).toBe(before);
	});

	it('refuses a storageId that is not on this draft', async () => {
		const { composable, bodyHtml } = await makeAttachments();
		const before = bodyHtml.value;

		await expect(composable.shareAsLink('st-nope')).resolves.toBe(false);

		expect(composable.attachments.value).toHaveLength(1);
		expect(bodyHtml.value).toBe(before);
	});
});
