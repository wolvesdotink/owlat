/**
 * Transient upload state machine for the composer attachment row. Tracks each
 * in-flight / failed upload as a "chip" with determinate progress, a thumbnail
 * (for images), a cancel that aborts the in-flight request, and a retry after a
 * failure. Committed (done) attachments do NOT live here — they graduate into
 * the parent's `attachments` ref via the `onCommitted` callback, so hydration,
 * send and the forgot-attachment guard keep operating on the same shape.
 *
 * The transport is injected (generateUploadUrl / putFile / attach) so the state
 * machine is unit-testable with a mocked transport and never imports Convex or
 * Nuxt-toast context directly.
 */

/** A committed attachment, matching the parent composable's `attachments` shape. */
export interface CommittedAttachment {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}

/** A transient chip: an upload that is in flight or has failed. */
export interface UploadChip {
	/** Stable client id (never a storageId — the upload has none until done). */
	id: string;
	filename: string;
	contentType: string;
	size: number;
	status: 'uploading' | 'failed';
	/** 0..1 determinate progress; ignored while `indeterminate`. */
	progress: number;
	/** Transport can't report progress yet — render a shimmer instead of a bar. */
	indeterminate: boolean;
	/** Object URL for an image preview, or null for non-images. */
	thumbUrl: string | null;
}

export interface UploadProgressCbs {
	onProgress: (fraction: number) => void;
	signal: AbortSignal;
}

export interface UploadTransport {
	/** Mint a one-shot Convex upload URL, or null on failure. */
	generateUploadUrl: () => Promise<string | null>;
	/**
	 * PUT/POST the file to the upload URL and resolve the resulting storageId.
	 * MUST honour `signal` (abort -> reject with an AbortError) and SHOULD call
	 * `onProgress` with 0..1 as bytes go out.
	 */
	putFile: (
		url: string,
		file: File,
		contentType: string,
		cbs: UploadProgressCbs,
	) => Promise<string>;
	/** Attach the uploaded storageId to the draft; false = server refused. */
	attach: (a: CommittedAttachment) => Promise<boolean>;
}

export interface AttachmentUploadsDeps extends UploadTransport {
	/** Called when an upload fully commits; parent appends to `attachments`. */
	onCommitted: (a: CommittedAttachment, thumbUrl: string | null) => void;
	/** Create an object URL for an image File (defaults to URL.createObjectURL). */
	createThumb?: (file: File) => string | null;
	/** Revoke an object URL (defaults to URL.revokeObjectURL). */
	revokeThumb?: (url: string) => void;
}

let chipSeq = 0;
function nextChipId(): string {
	chipSeq += 1;
	return `up_${Date.now().toString(36)}_${chipSeq}`;
}

function isImage(type: string): boolean {
	return type.startsWith('image/');
}

function isAbortError(err: unknown): boolean {
	return (
		err instanceof DOMException
			? err.name === 'AbortError'
			: !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'
	);
}

export function createAttachmentUploads(deps: AttachmentUploadsDeps) {
	const createThumb =
		deps.createThumb ??
		((file: File) => (isImage(file.type) ? URL.createObjectURL(file) : null));
	const revokeThumb = deps.revokeThumb ?? ((url: string) => URL.revokeObjectURL(url));

	const uploads = ref<UploadChip[]>([]);
	// Non-reactive per-chip state: the source File (for retry) and the live
	// AbortController (for cancel). Kept out of the reactive chip so aborting
	// doesn't churn the render.
	const files = new Map<string, File>();
	const controllers = new Map<string, AbortController>();

	const isUploading = computed(() => uploads.value.some((c) => c.status === 'uploading'));

	function patch(id: string, next: Partial<UploadChip>) {
		uploads.value = uploads.value.map((c) => (c.id === id ? { ...c, ...next } : c));
	}

	function forget(id: string) {
		const chip = uploads.value.find((c) => c.id === id);
		if (chip?.thumbUrl) revokeThumb(chip.thumbUrl);
		uploads.value = uploads.value.filter((c) => c.id !== id);
		files.delete(id);
		controllers.delete(id);
	}

	async function run(id: string) {
		const file = files.get(id);
		if (!file) return;
		const contentType = file.type || 'application/octet-stream';
		const controller = new AbortController();
		controllers.set(id, controller);
		patch(id, { status: 'uploading', progress: 0, indeterminate: true });
		try {
			const url = await deps.generateUploadUrl();
			if (!url) {
				patch(id, { status: 'failed', indeterminate: false });
				return;
			}
			const storageId = await deps.putFile(url, file, contentType, {
				signal: controller.signal,
				onProgress: (fraction) => {
					patch(id, {
						indeterminate: false,
						progress: Math.max(0, Math.min(1, fraction)),
					});
				},
			});
			const attachment: CommittedAttachment = {
				storageId,
				filename: file.name,
				contentType,
				size: file.size,
			};
			const ok = await deps.attach(attachment);
			if (!ok) {
				patch(id, { status: 'failed', indeterminate: false });
				return;
			}
			// Committed: hand the thumb URL to the parent (it now owns the object
			// URL's lifetime) and drop the transient chip WITHOUT revoking it.
			const chip = uploads.value.find((c) => c.id === id);
			const thumbUrl = chip?.thumbUrl ?? null;
			uploads.value = uploads.value.filter((c) => c.id !== id);
			files.delete(id);
			controllers.delete(id);
			deps.onCommitted(attachment, thumbUrl);
		} catch (err) {
			if (isAbortError(err)) {
				// Cancelled by the user: remove the chip entirely.
				forget(id);
				return;
			}
			patch(id, { status: 'failed', indeterminate: false });
		} finally {
			controllers.delete(id);
		}
	}

	/** Begin uploading each file as its own chip. */
	function addFiles(list: File[]) {
		for (const file of list) {
			const id = nextChipId();
			files.set(id, file);
			uploads.value = [
				...uploads.value,
				{
					id,
					filename: file.name,
					contentType: file.type || 'application/octet-stream',
					size: file.size,
					status: 'uploading',
					progress: 0,
					indeterminate: true,
					thumbUrl: createThumb(file),
				},
			];
			void run(id);
		}
	}

	/** Cancel an in-flight upload (aborts the request) or dismiss a failed one. */
	function cancel(id: string) {
		const controller = controllers.get(id);
		if (controller) {
			// Abort -> run()'s catch removes the chip. Guard in case the transport
			// ignores the signal: drop it here too.
			controller.abort();
		}
		if (uploads.value.some((c) => c.id === id)) forget(id);
	}

	/** Retry a failed upload with the original File. */
	function retry(id: string) {
		const chip = uploads.value.find((c) => c.id === id);
		if (!chip || chip.status !== 'failed' || !files.has(id)) return;
		void run(id);
	}

	/** Revoke every outstanding thumbnail (call on unmount). */
	function dispose() {
		for (const chip of uploads.value) {
			if (chip.thumbUrl) revokeThumb(chip.thumbUrl);
		}
		uploads.value = [];
		files.clear();
		controllers.clear();
	}

	return { uploads, isUploading, addFiles, cancel, retry, dispose };
}

/**
 * XHR-based upload primitive: PUTs a File to a Convex upload URL, reporting
 * determinate progress via `upload.onprogress` and honouring an AbortSignal.
 * Resolves the storageId parsed from the JSON response. Used as the real
 * `putFile` transport; tests inject a fake instead.
 */
export function xhrPutFile(
	url: string,
	file: File,
	contentType: string,
	{ onProgress, signal }: UploadProgressCbs,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('POST', url, true);
		xhr.setRequestHeader('Content-Type', contentType);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
		};
		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) {
				reject(new Error(`Upload failed (${xhr.status})`));
				return;
			}
			try {
				const { storageId } = JSON.parse(xhr.responseText) as { storageId: string };
				if (!storageId) reject(new Error('Upload response missing storageId'));
				else resolve(storageId);
			} catch {
				reject(new Error('Upload response was not valid JSON'));
			}
		};
		xhr.onerror = () => reject(new Error('Upload network error'));
		xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
		if (signal.aborted) {
			xhr.abort();
			return;
		}
		signal.addEventListener('abort', () => xhr.abort(), { once: true });
		xhr.send(file);
	});
}
