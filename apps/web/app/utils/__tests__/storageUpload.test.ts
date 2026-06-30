import { describe, it, expect, vi, afterEach } from 'vitest';
import { uploadFileToStorage } from '../storageUpload';

const file = new File(['data'], 'x.png', { type: 'image/png' });

afterEach(() => {
	vi.restoreAllMocks();
});

describe('uploadFileToStorage', () => {
	it('returns the storageId on success', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ storageId: 'st_1' }), { status: 200 })));
		const res = await uploadFileToStorage(file, async () => 'https://upload');
		expect(res).toEqual({ ok: true, storageId: 'st_1' });
	});

	it('reports no-url when the upload URL is undefined (and never fetches)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await uploadFileToStorage(file, async () => undefined);
		expect(res).toEqual({ ok: false, reason: 'no-url' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reports upload-failed on a non-2xx response', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
		const res = await uploadFileToStorage(file, async () => 'https://upload');
		expect(res).toEqual({ ok: false, reason: 'upload-failed' });
	});

	it('reports no-storage-id when the response lacks a storageId', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
		const res = await uploadFileToStorage(file, async () => 'https://upload');
		expect(res).toEqual({ ok: false, reason: 'no-storage-id' });
	});

	it('uses the supplied content type, defaulting to the file type', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ storageId: 's' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await uploadFileToStorage(file, async () => 'https://upload', 'application/octet-stream');
		expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
		await uploadFileToStorage(file, async () => 'https://upload');
		expect(fetchMock.mock.calls[1]![1]!.headers).toEqual({ 'Content-Type': 'image/png' });
	});

	it('propagates a transport error from fetch (callers wrap in try/catch)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
		await expect(uploadFileToStorage(file, async () => 'https://upload')).rejects.toThrow('network');
	});
});
