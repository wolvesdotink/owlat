import { describe, expect, it, vi } from 'vitest';
import { BodyTooLargeError, readBodyBytes, readBodyText } from '../readBody';
import { parseBody } from '../publicTokenEndpoint';

function streamRequest(chunks: Uint8Array[], headers?: HeadersInit) {
	let consumed = 0;
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[consumed++];
				if (chunk) controller.enqueue(chunk);
				else controller.close();
			},
			cancel,
		},
		{ highWaterMark: 0 }
	);
	const request = new Request('https://owlat.example/body', {
		method: 'POST',
		headers,
		body,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	return { request, cancel, consumed: () => consumed };
}

describe('HTTP wire body limits', () => {
	it.each([undefined, { 'Content-Length': '1' }])(
		'stops at the first overflowing chunk (%j)',
		async (headers) => {
			const stream = streamRequest(
				[new Uint8Array(4), new Uint8Array(5), new Uint8Array(100)],
				headers
			);
			await expect(readBodyBytes(stream.request, 8)).rejects.toBeInstanceOf(BodyTooLargeError);
			expect(stream.consumed()).toBe(2);
			expect(stream.cancel).toHaveBeenCalledOnce();
		}
	);

	it('rejects declared oversized bodies without pulling a chunk', async () => {
		const stream = streamRequest([new Uint8Array(100)], { 'Content-Length': '100' });
		await expect(readBodyBytes(stream.request, 8)).rejects.toBeInstanceOf(BodyTooLargeError);
		expect(stream.consumed()).toBe(0);
		expect(stream.cancel).toHaveBeenCalledOnce();
	});

	it('preserves exact bytes and split UTF-8 sequences at the inclusive limit', async () => {
		const bytes = new TextEncoder().encode('a€z');
		const stream = streamRequest([bytes.slice(0, 2), bytes.slice(2)]);
		await expect(readBodyText(stream.request, bytes.byteLength)).resolves.toBe('a€z');
	});

	it('propagates a broken stream and releases its reader', async () => {
		const body = new ReadableStream({
			pull(controller) {
				controller.error(new Error('broken'));
			},
		});
		const request = new Request('https://owlat.example/', {
			method: 'POST',
			body,
			duplex: 'half',
		} as RequestInit);
		await expect(readBodyBytes(request, 8)).rejects.toThrow('broken');
		expect(request.body?.locked).toBe(false);
	});

	it('rejects public JSON whose characters fit but UTF-8 bytes exceed 100 KB', async () => {
		const request = new Request('https://owlat.example/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: '€'.repeat(34_000) }),
		});
		await expect(parseBody(request, 'json')).rejects.toThrow('Request body too large');
	});

	it('counts multipart framing and repeated empty fields before parsing', async () => {
		const field = '--boundary\r\nContent-Disposition: form-data; name="x"\r\n\r\n\r\n';
		const request = new Request('https://owlat.example/', {
			method: 'POST',
			headers: { 'Content-Type': 'multipart/form-data; boundary=boundary' },
			body: field.repeat(2_000) + '--boundary--\r\n',
		});
		await expect(parseBody(request, 'formData')).rejects.toThrow('Request body too large');
	});
});
