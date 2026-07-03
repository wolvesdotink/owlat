import { describe, it, expect, vi } from 'vitest';
import {
	createAttachmentUploads,
	type AttachmentUploadsDeps,
	type CommittedAttachment,
	type UploadProgressCbs,
} from '../postboxAttachmentUploads';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeFile(name: string, size: number, type = 'text/plain'): File {
	const f = new File(['x'], name, { type });
	Object.defineProperty(f, 'size', { value: size });
	return f;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface PutCall {
	cbs: UploadProgressCbs;
	deferred: Deferred<string>;
}

function harness(overrides: Partial<AttachmentUploadsDeps> = {}) {
	const puts: PutCall[] = [];
	const committed: Array<{ a: CommittedAttachment; thumb: string | null }> = [];
	const deps: AttachmentUploadsDeps = {
		generateUploadUrl: vi.fn(async () => 'https://upload.example'),
		putFile: vi.fn((_url, _file, _ct, cbs) => {
			const d = deferred<string>();
			puts.push({ cbs, deferred: d });
			return d.promise;
		}),
		attach: vi.fn(async () => true),
		onCommitted: vi.fn((a: CommittedAttachment, thumb: string | null) =>
			committed.push({ a, thumb }),
		),
		createThumb: () => null,
		revokeThumb: vi.fn(),
		...overrides,
	};
	const uploader = createAttachmentUploads(deps);
	return { uploader, deps, puts, committed };
}

describe('createAttachmentUploads state machine', () => {
	it('uploading -> done: reports progress then commits and drops the chip', async () => {
		const { uploader, deps, puts, committed } = harness();
		uploader.addFiles([makeFile('report.pdf', 1000, 'application/pdf')]);

		// Chip appears immediately as uploading + indeterminate.
		expect(uploader.uploads.value).toHaveLength(1);
		expect(uploader.uploads.value[0]!.status).toBe('uploading');
		expect(uploader.uploads.value[0]!.indeterminate).toBe(true);
		expect(uploader.isUploading.value).toBe(true);

		await tick(); // generateUploadUrl resolves -> putFile invoked
		expect(puts).toHaveLength(1);

		// Transport reports progress: bar goes determinate.
		puts[0]!.cbs.onProgress(0.5);
		expect(uploader.uploads.value[0]!.indeterminate).toBe(false);
		expect(uploader.uploads.value[0]!.progress).toBe(0.5);

		puts[0]!.deferred.resolve('storage_1');
		await tick(); // attach resolves -> commit

		expect(deps.attach).toHaveBeenCalledWith(
			expect.objectContaining({ storageId: 'storage_1', filename: 'report.pdf', size: 1000 }),
		);
		expect(committed).toHaveLength(1);
		expect(committed[0]!.a.storageId).toBe('storage_1');
		// Chip graduates out of the transient list.
		expect(uploader.uploads.value).toHaveLength(0);
		expect(uploader.isUploading.value).toBe(false);
	});

	it('failed -> retry -> done', async () => {
		const { uploader, puts, committed } = harness();
		uploader.addFiles([makeFile('a.txt', 10)]);
		await tick();

		// First attempt fails at the transport.
		puts[0]!.deferred.reject(new Error('boom'));
		await tick();
		expect(uploader.uploads.value).toHaveLength(1);
		expect(uploader.uploads.value[0]!.status).toBe('failed');
		expect(committed).toHaveLength(0);

		const id = uploader.uploads.value[0]!.id;
		uploader.retry(id);
		expect(uploader.uploads.value[0]!.status).toBe('uploading');
		await tick(); // second putFile

		expect(puts).toHaveLength(2);
		puts[1]!.deferred.resolve('storage_retry');
		await tick();

		expect(committed).toHaveLength(1);
		expect(committed[0]!.a.storageId).toBe('storage_retry');
		expect(uploader.uploads.value).toHaveLength(0);
	});

	it('marks the chip failed when the server refuses the attach (attach -> false)', async () => {
		const { uploader, puts, committed } = harness({ attach: vi.fn(async () => false) });
		uploader.addFiles([makeFile('a.txt', 10)]);
		await tick();
		puts[0]!.deferred.resolve('storage_x');
		await tick();
		expect(uploader.uploads.value[0]!.status).toBe('failed');
		expect(committed).toHaveLength(0);
	});

	it('marks the chip failed when no upload URL can be minted', async () => {
		const { uploader, puts } = harness({ generateUploadUrl: vi.fn(async () => null) });
		uploader.addFiles([makeFile('a.txt', 10)]);
		await tick();
		expect(puts).toHaveLength(0); // never reached the transport
		expect(uploader.uploads.value[0]!.status).toBe('failed');
	});

	it('cancel aborts the in-flight upload and removes the chip', async () => {
		let aborted = false;
		const putFile = vi.fn(
			(_url: string, _file: File, _ct: string, { signal }: UploadProgressCbs) =>
				new Promise<string>((_, reject) => {
					signal.addEventListener('abort', () => {
						aborted = true;
						reject(new DOMException('aborted', 'AbortError'));
					});
				}),
		);
		const { uploader, committed } = harness({ putFile });
		uploader.addFiles([makeFile('big.zip', 999)]);
		await tick();

		const id = uploader.uploads.value[0]!.id;
		uploader.cancel(id);
		await tick();

		expect(aborted).toBe(true);
		expect(uploader.uploads.value).toHaveLength(0);
		expect(committed).toHaveLength(0);
		expect(uploader.isUploading.value).toBe(false);
	});

	it('creates and revokes a thumbnail object URL for image chips on cancel', async () => {
		const revokeThumb = vi.fn();
		const { uploader } = harness({
			createThumb: (f) => (f.type.startsWith('image/') ? `blob:${f.name}` : null),
			revokeThumb,
			putFile: vi.fn(
				(_u, _f, _c, { signal }: UploadProgressCbs) =>
					new Promise<string>((_, reject) => {
						signal.addEventListener('abort', () =>
							reject(new DOMException('aborted', 'AbortError')),
						);
					}),
			),
		});
		uploader.addFiles([makeFile('pic.png', 500, 'image/png')]);
		expect(uploader.uploads.value[0]!.thumbUrl).toBe('blob:pic.png');
		await tick();

		uploader.cancel(uploader.uploads.value[0]!.id);
		await tick();
		expect(revokeThumb).toHaveBeenCalledWith('blob:pic.png');
	});

	it('hands the committed thumbnail to the parent without revoking it', async () => {
		const revokeThumb = vi.fn();
		const { uploader, puts, committed } = harness({
			createThumb: () => 'blob:keep',
			revokeThumb,
		});
		uploader.addFiles([makeFile('pic.png', 500, 'image/png')]);
		await tick();
		puts[0]!.deferred.resolve('storage_img');
		await tick();
		expect(committed[0]!.thumb).toBe('blob:keep');
		// Ownership transferred to the parent; the uploader must NOT revoke it.
		expect(revokeThumb).not.toHaveBeenCalled();
	});
});
