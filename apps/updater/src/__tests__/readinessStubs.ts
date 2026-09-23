import { vi } from 'vitest';
import { setReadinessTiming } from '../readiness.js';

/**
 * The endpoint tests drive a real HTTP server, and every rollout that reaches
 * `docker compose up` now waits for readiness. Shrink the wait to a few
 * milliseconds, and answer the readiness check's request to the web app (the
 * `web` host only exists on the compose network) while letting the test's own
 * requests to the server through.
 */
export function fastReadiness(): { webStatus: (status: number) => void; restore: () => void } {
	setReadinessTiming({ timeoutMs: 40, firstPollMs: 1, maxPollMs: 2, settleMs: 1 });
	let status = 200;
	const realFetch = globalThis.fetch;
	const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.startsWith('http://web:3000/')) {
			return Promise.resolve(new Response('{}', { status }));
		}
		return realFetch(input, init);
	});
	return {
		webStatus: (next) => {
			status = next;
		},
		restore: () => {
			spy.mockRestore();
			setReadinessTiming(null);
		},
	};
}
