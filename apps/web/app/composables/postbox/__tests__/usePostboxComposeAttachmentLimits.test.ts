import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';

/**
 * Regression: the interactive compose path (`addFiles`) must enforce the same
 * per-message ceilings the send path does — attachment COUNT and combined SIZE,
 * not just the per-file byte cap. Without these gates a user could queue
 * 10×25 MB (or more than maxCount files) and OOM the send. Each breach must be
 * rejected with an error toast and the offending files must NOT reach the
 * uploader.
 */

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mail: {
			drafts: {
				addAttachment: 'drafts.addAttachment',
				removeAttachment: 'drafts.removeAttachment',
			},
		},
	},
}));

// A controllable stand-in for the upload state machine. Its `addFiles` records
// what the gate let through and mirrors each file into `uploads` (with its size)
// so the composable's own count/byte accounting sees the growing footprint.
const uploads = ref<Array<{ id: string; size: number; filename: string }>>([]);
const uploaderAddFiles = vi.fn((list: File[]) => {
	for (const f of list) {
		uploads.value = [
			...uploads.value,
			{ id: `u${uploads.value.length}`, size: f.size, filename: f.name },
		];
	}
});

vi.mock('../postboxAttachmentUploads', () => ({
	createAttachmentUploads: () => ({
		uploads,
		isUploading: ref(false),
		addFiles: uploaderAddFiles,
		cancel: () => {},
		retry: () => {},
		dispose: () => {},
	}),
	xhrPutFile: () => Promise.resolve('sid'),
}));

const showToast = vi.fn();

beforeEach(() => {
	uploads.value = [];
	uploaderAddFiles.mockClear();
	showToast.mockClear();
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(async () => undefined) }));
	vi.stubGlobal('usePostboxPendingAttachments', () => ({ take: () => null }));
});

async function loadComposable() {
	const mod = await import('../usePostboxComposeAttachments');
	return mod.usePostboxComposeAttachments;
}

function makeFile(name: string, size: number): File {
	const f = new File(['x'], name, { type: 'application/octet-stream' });
	Object.defineProperty(f, 'size', { value: size });
	return f;
}

function makeComposable(use: Awaited<ReturnType<typeof loadComposable>>) {
	return use({
		ensureDraft: async () => 'draft-1' as never,
		draftId: ref('draft-1' as never),
	});
}

describe('usePostboxComposeAttachments — compose limits', () => {
	it('rejects files past maxCount with a toast and does not add them', async () => {
		const use = await loadComposable();
		const composer = makeComposable(use);

		// One more than the allowed count, each tiny so only the COUNT gate trips.
		const files = Array.from({ length: ATTACHMENT_COMPOSE_LIMITS.maxCount + 1 }, (_, i) =>
			makeFile(`f${i}.bin`, 1024),
		);
		await composer.addFiles(files);

		// Exactly maxCount reach the uploader; the surplus is dropped with a toast.
		expect(uploaderAddFiles).toHaveBeenCalledOnce();
		expect(uploaderAddFiles.mock.calls[0]![0]).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(uploads.value).toHaveLength(ATTACHMENT_COMPOSE_LIMITS.maxCount);
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('up to'), 'error');
	});

	it('rejects files past maxTotalBytes with a toast and does not add them', async () => {
		const use = await loadComposable();
		const composer = makeComposable(use);

		// Three files whose combined size exceeds maxTotalBytes but each is under
		// the per-file cap — only the combined-SIZE gate should trip.
		const half = Math.ceil(ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes / 2);
		await composer.addFiles([
			makeFile('a.bin', half),
			makeFile('b.bin', half),
			makeFile('c.bin', half),
		]);

		// First two fit (2×half >= budget only on the third), third is rejected.
		expect(uploaderAddFiles).toHaveBeenCalledOnce();
		expect(uploaderAddFiles.mock.calls[0]![0]).toHaveLength(2);
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('total limit'), 'error');
	});

	it('accepts files that stay within both caps', async () => {
		const use = await loadComposable();
		const composer = makeComposable(use);

		await composer.addFiles([makeFile('a.bin', 1024), makeFile('b.bin', 2048)]);

		expect(uploaderAddFiles).toHaveBeenCalledOnce();
		expect(uploaderAddFiles.mock.calls[0]![0]).toHaveLength(2);
		expect(showToast).not.toHaveBeenCalled();
	});
});
