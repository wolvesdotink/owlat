import { readStreamBytes, StreamByteLimitExceeded } from '@owlat/shared';

/** Byte limits for HTTP actions must be enforced while reading, before parsing. */
export class BodyTooLargeError extends Error {
	constructor() {
		super('Request body too large');
		this.name = 'BodyTooLargeError';
	}
}

/** Read bounded wire bytes, including multipart framing and repeated fields. */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<ArrayBuffer> {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		void request.body?.cancel().catch(() => undefined);
		throw new BodyTooLargeError();
	}
	try {
		const bytes = await readStreamBytes(request.body, maxBytes);
		return bytes?.buffer ?? new ArrayBuffer(0);
	} catch (error) {
		if (error instanceof StreamByteLimitExceeded) throw new BodyTooLargeError();
		throw error;
	}
}

export async function readBodyText(request: Request, maxBytes: number): Promise<string> {
	return new TextDecoder().decode(await readBodyBytes(request, maxBytes));
}
