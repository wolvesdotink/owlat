// @vitest-environment node
/**
 * The worker entry, loaded the way a dedicated worker loads it: a global
 * scope with `addEventListener` and `postMessage` and no DOM. Every request
 * gets an answer carrying its id, including one whose render throws.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type {
	PostboxRenderWorkerRequest,
	PostboxRenderWorkerResponse,
} from '~/utils/postboxRenderPipeline';

let onMessage: ((event: { data: PostboxRenderWorkerRequest }) => void) | null = null;
const posted: PostboxRenderWorkerResponse[] = [];

beforeAll(async () => {
	vi.stubGlobal('addEventListener', (type: string, listener: typeof onMessage) => {
		if (type === 'message') onMessage = listener;
	});
	vi.stubGlobal('postMessage', (response: PostboxRenderWorkerResponse) => posted.push(response));
	await import('../postboxRender.worker');
});

afterAll(() => {
	vi.unstubAllGlobals();
});

describe('postbox render worker', () => {
	it('answers a request with the sanitized pipeline output', () => {
		expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
		onMessage!({
			data: {
				id: 7,
				input: {
					html: '<p onclick="x()">Hello</p><script>alert(1)</script>',
					text: '',
					showQuoted: false,
					scheme: 'dark',
					cidUrls: new Map(),
				},
			},
		});
		const response = posted.at(-1)!;
		expect(response.id).toBe(7);
		expect(response.ok).toBe(true);
		if (!response.ok) return;
		expect(response.output.html).toContain('Hello');
		expect(response.output.html).not.toMatch(/onclick|<script/);
		expect(response.output.scheme).toBe('dark');
	});

	it('answers a request whose render throws with an error, not silence', () => {
		onMessage!({
			data: {
				id: 8,
				// A malformed request (no map) makes the cid stage throw.
				input: { html: '<img src="cid:a">', text: '', showQuoted: false, scheme: 'light' },
			} as unknown as { id: number; input: PostboxRenderWorkerRequest['input'] },
		});
		const response = posted.at(-1)!;
		expect(response).toMatchObject({ id: 8, ok: false });
	});
});
