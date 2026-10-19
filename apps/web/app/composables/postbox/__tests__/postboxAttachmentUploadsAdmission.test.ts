import { describe, it, expect, vi } from 'vitest';
import {
	createAttachmentUploads,
	MAX_ACTIVE_UPLOADS,
	type AttachmentUploadsDeps,
	type UploadProgressCbs,
} from '../postboxAttachmentUploads';

/**
 * Transfer admission inside one composer (plan item OW-067): at most
 * `maxActive` uploads run at once, the rest wait as queued chips in the order
 * they were added, and a queued chip that is cancelled never starts. Every
 * transport step is a promise the test settles by hand, so no clock is read.
 */

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeFile(name: string, size = 10): File {
	const f = new File(['x'], name, { type: 'text/plain' });
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
	filename: string;
	cbs: UploadProgressCbs;
	deferred: Deferred<string>;
}

function harness(overrides: Partial<AttachmentUploadsDeps> = {}) {
	const puts: PutCall[] = [];
	// Live transfers: putFile entered and not yet settled.
	let active = 0;
	let peak = 0;
	const deps: AttachmentUploadsDeps = {
		generateUploadUrl: vi.fn(async () => 'https://upload.owlat.example'),
		putFile: vi.fn((_url, file: File, _ct, cbs: UploadProgressCbs) => {
			const d = deferred<string>();
			active += 1;
			peak = Math.max(peak, active);
			const done = () => {
				active -= 1;
			};
			d.promise.then(done, done);
			// Honour the abort the way xhrPutFile does.
			cbs.signal.addEventListener(
				'abort',
				() => d.reject(new DOMException('Upload aborted', 'AbortError')),
				{ once: true }
			);
			puts.push({ filename: file.name, cbs, deferred: d });
			return d.promise;
		}),
		attach: vi.fn(async () => true),
		detach: vi.fn(async () => true),
		onCommitted: vi.fn(),
		createThumb: () => null,
		revokeThumb: vi.fn(),
		...overrides,
	};
	const uploader = createAttachmentUploads(deps);
	const statuses = () => uploader.uploads.value.map((c) => `${c.filename}:${c.status}`);
	return {
		uploader,
		deps,
		puts,
		statuses,
		active: () => active,
		peak: () => peak,
	};
}

const names = (n: number) => Array.from({ length: n }, (_, i) => makeFile(`f${i}.txt`));

describe('createAttachmentUploads admission', () => {
	it('caps the active transfers by default', () => {
		expect(MAX_ACTIVE_UPLOADS).toBe(3);
	});

	it('runs 20 files with never more than the limit active, in the order added', async () => {
		const h = harness();
		h.uploader.addFiles(names(20));

		// The first three start; the rest are queued and have minted nothing.
		const head = h.uploader.uploads.value.slice(0, 3).map((c) => c.status);
		expect(head).toEqual(['uploading', 'uploading', 'uploading']);
		expect(h.uploader.uploads.value.slice(3).every((c) => c.status === 'queued')).toBe(true);
		expect(h.deps.generateUploadUrl).toHaveBeenCalledTimes(3);
		expect(h.uploader.isUploading.value).toBe(true);

		// Finish whichever transfer is oldest, one at a time, until all are done.
		for (let done = 0; done < 20; done += 1) {
			await tick();
			expect(h.active()).toBeLessThanOrEqual(3);
			expect(
				h.uploader.uploads.value.filter((c) => c.status === 'uploading').length
			).toBeLessThanOrEqual(3);
			h.puts[done]!.deferred.resolve(`storage_${done}`);
		}
		await tick();

		expect(h.peak()).toBe(3);
		expect(h.puts.map((p) => p.filename)).toEqual(names(20).map((f) => f.name));
		expect(h.deps.onCommitted).toHaveBeenCalledTimes(20);
		expect(h.uploader.uploads.value).toHaveLength(0);
		expect(h.uploader.isUploading.value).toBe(false);
	});

	it('honours a smaller configured limit', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(3));
		await tick();
		expect(h.statuses()).toEqual(['f0.txt:uploading', 'f1.txt:queued', 'f2.txt:queued']);
		expect(h.puts).toHaveLength(1);
	});

	it('cancelling a queued chip removes it without minting an upload URL', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(3));
		await tick();
		const queued = h.uploader.uploads.value[1]!;
		expect(queued.status).toBe('queued');

		h.uploader.cancel(queued.id);
		expect(h.statuses()).toEqual(['f0.txt:uploading', 'f2.txt:queued']);

		h.puts[0]!.deferred.resolve('storage_0');
		await tick();
		h.puts[1]!.deferred.resolve('storage_2');
		await tick();

		// Two URLs for two transfers: the cancelled file never started.
		expect(h.deps.generateUploadUrl).toHaveBeenCalledTimes(2);
		expect(h.puts.map((p) => p.filename)).toEqual(['f0.txt', 'f2.txt']);
		expect(h.uploader.uploads.value).toHaveLength(0);
	});

	it('cancelling every queued chip leaves isUploading to the running transfer', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(2));
		h.uploader.cancel(h.uploader.uploads.value[1]!.id);
		expect(h.uploader.isUploading.value).toBe(true);
		h.uploader.cancel(h.uploader.uploads.value[0]!.id);
		await tick();
		expect(h.uploader.isUploading.value).toBe(false);
		expect(h.deps.generateUploadUrl).toHaveBeenCalledTimes(1);
	});

	it('a failed transfer frees its slot for the next queued file', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(2));
		await tick();
		h.puts[0]!.deferred.reject(new Error('network'));
		await tick();
		expect(h.statuses()).toEqual(['f0.txt:failed', 'f1.txt:uploading']);
		expect(h.puts).toHaveLength(2);
	});

	it('a refused upload URL frees its slot', async () => {
		const generateUploadUrl = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce(null)
			.mockResolvedValue('https://upload.owlat.example');
		const h = harness({ maxActive: 1, generateUploadUrl });
		h.uploader.addFiles(names(2));
		await tick();
		expect(h.statuses()).toEqual(['f0.txt:failed', 'f1.txt:uploading']);
	});

	it('cancelling a running transfer frees its slot', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(2));
		await tick();
		h.uploader.cancel(h.uploader.uploads.value[0]!.id);
		await tick();
		expect(h.statuses()).toEqual(['f1.txt:uploading']);
		expect(h.puts.map((p) => p.filename)).toEqual(['f0.txt', 'f1.txt']);
		expect(h.peak()).toBe(1);
	});

	it('holds the slot of a cancelled run until its attach settles', async () => {
		const attachCall = deferred<boolean>();
		const h = harness({ maxActive: 1, attach: vi.fn(() => attachCall.promise) });
		h.uploader.addFiles(names(2));
		await tick();
		h.puts[0]!.deferred.resolve('storage_0');
		await tick(); // attach in flight
		h.uploader.cancel(h.uploader.uploads.value[0]!.id);
		await tick();
		// The run is still settling its attach, so the next file waits.
		expect(h.statuses()).toEqual(['f1.txt:queued']);
		attachCall.resolve(true);
		await tick();
		expect(h.deps.detach).toHaveBeenCalledTimes(1);
		expect(h.statuses()).toEqual(['f1.txt:uploading']);
	});

	it('a retry waits its turn behind the queue', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(1));
		await tick();
		h.puts[0]!.deferred.reject(new Error('network'));
		await tick();
		const failedId = h.uploader.uploads.value[0]!.id;

		h.uploader.addFiles([makeFile('next.txt')]);
		h.uploader.retry(failedId);
		expect(h.statuses()).toEqual(['f0.txt:queued', 'next.txt:uploading']);

		await tick();
		h.puts[1]!.deferred.resolve('storage_next');
		await tick();
		expect(h.statuses()).toEqual(['f0.txt:uploading']);
		expect(h.puts.map((p) => p.filename)).toEqual(['f0.txt', 'next.txt', 'f0.txt']);
	});

	it('byte progress still reaches a started chip', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(2));
		await tick();
		h.puts[0]!.cbs.onProgress(0.4);
		const [running, queued] = h.uploader.uploads.value;
		expect(running).toMatchObject({ status: 'uploading', progress: 0.4, indeterminate: false });
		expect(queued).toMatchObject({ status: 'queued', progress: 0 });
	});

	it('keeps separate composers independent', async () => {
		const shared = harness({ maxActive: 1 });
		// A second composer on the same transport: its own queue and its own slot.
		const other = createAttachmentUploads({ ...shared.deps, maxActive: 1 });
		shared.uploader.addFiles(names(2));
		other.addFiles([makeFile('other.txt')]);
		await tick();
		expect(other.uploads.value[0]!.status).toBe('uploading');
		expect(shared.statuses()).toEqual(['f0.txt:uploading', 'f1.txt:queued']);
		expect(shared.puts.map((p) => p.filename)).toEqual(['f0.txt', 'other.txt']);
	});

	it('dispose drops the queue so nothing starts afterwards', async () => {
		const h = harness({ maxActive: 1 });
		h.uploader.addFiles(names(3));
		await tick();
		h.uploader.dispose();
		h.puts[0]!.deferred.resolve('storage_0');
		await tick();
		expect(h.deps.generateUploadUrl).toHaveBeenCalledTimes(1);
		expect(h.uploader.uploads.value).toHaveLength(0);
	});
});
