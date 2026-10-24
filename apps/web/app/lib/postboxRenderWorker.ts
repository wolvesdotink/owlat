/**
 * One shared render worker for every Postbox message body in the tab.
 *
 * A thread can mount a dozen bodies at once, so the worker is created lazily,
 * once, and requests go through it one at a time: a request that is cancelled
 * while it waits (its message closed, its options changed) is dropped before
 * it is ever posted, and only the request in flight can still spend worker
 * time on a body nobody shows.
 *
 * Failure settles every request rather than leaving it to wait: a worker that
 * cannot start or dies rejects what it holds and the client stays broken for
 * the session, so callers render on the main thread from then on (the same
 * pipeline, so a dead worker costs speed, never safety). A render that throws
 * inside a healthy worker rejects only that request.
 */

import type {
	PostboxRenderStageInput,
	PostboxRenderStageOutput,
	PostboxRenderWorkerRequest,
	PostboxRenderWorkerResponse,
} from '~/utils/postboxRenderPipeline';

/** The slice of `Worker` the client uses. */
export interface PostboxRenderWorkerPort {
	postMessage(request: PostboxRenderWorkerRequest): void;
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
	addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
	terminate(): void;
}

export interface PostboxRenderJob {
	readonly promise: Promise<PostboxRenderStageOutput>;
	/** Drop the request: it is never posted if still queued, and never settles. */
	cancel(): void;
}

export interface PostboxRenderClient {
	render(input: PostboxRenderStageInput): PostboxRenderJob;
	/** The worker failed; every later request rejects at once. */
	readonly broken: boolean;
}

interface QueuedJob {
	id: number;
	input: PostboxRenderStageInput;
	cancelled: boolean;
	resolve: (output: PostboxRenderStageOutput) => void;
	reject: (error: Error) => void;
}

export function createPostboxRenderClient(
	createWorker: () => PostboxRenderWorkerPort
): PostboxRenderClient {
	let worker: PostboxRenderWorkerPort | null = null;
	let broken = false;
	let nextId = 1;
	let inFlight: QueuedJob | null = null;
	const queue: QueuedJob[] = [];

	function failAll(error: Error): void {
		broken = true;
		const pending = inFlight ? [inFlight, ...queue] : [...queue];
		inFlight = null;
		queue.length = 0;
		try {
			worker?.terminate();
		} catch {
			// Already gone; nothing left to stop.
		}
		worker = null;
		for (const job of pending) if (!job.cancelled) job.reject(error);
	}

	function onMessage(event: MessageEvent): void {
		const response = event.data as PostboxRenderWorkerResponse;
		const job = inFlight;
		if (!job || response?.id !== job.id) return;
		inFlight = null;
		if (!job.cancelled) {
			if (response.ok) job.resolve(response.output);
			else job.reject(new Error(response.error));
		}
		pump();
	}

	function startWorker(): PostboxRenderWorkerPort {
		const created = createWorker();
		created.addEventListener('message', onMessage);
		// A script that fails to load, or an error the worker could not answer.
		created.addEventListener('error', () => failAll(new Error('postbox render worker failed')));
		// The answer in flight could not be read; the worker itself is fine.
		created.addEventListener('messageerror', () => {
			const job = inFlight;
			inFlight = null;
			if (job && !job.cancelled) job.reject(new Error('postbox render response unreadable'));
			pump();
		});
		return created;
	}

	function pump(): void {
		if (broken || inFlight) return;
		let job = queue.shift();
		while (job?.cancelled) job = queue.shift();
		if (!job) return;
		// In flight before the worker starts, so a failed start settles it too.
		inFlight = job;
		try {
			worker ??= startWorker();
			// oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker.postMessage has no target origin
			worker.postMessage({ id: job.id, input: job.input });
		} catch (error) {
			failAll(error instanceof Error ? error : new Error(String(error)));
		}
	}

	return {
		render(input) {
			let settle!: Pick<QueuedJob, 'resolve' | 'reject'>;
			const promise = new Promise<PostboxRenderStageOutput>((resolve, reject) => {
				settle = { resolve, reject };
			});
			const job: QueuedJob = { id: nextId++, input, cancelled: false, ...settle };
			if (broken) job.reject(new Error('postbox render worker unavailable'));
			else {
				queue.push(job);
				pump();
			}
			return {
				promise,
				cancel() {
					job.cancelled = true;
					const index = queue.indexOf(job);
					if (index !== -1) queue.splice(index, 1);
				},
			};
		},
		get broken() {
			return broken;
		},
	};
}

let shared: PostboxRenderClient | null = null;

/**
 * The tab's render client, or null when bodies render on the main thread: no
 * `Worker` here (tests, very old engines) or the worker already failed.
 */
export function getPostboxRenderClient(): PostboxRenderClient | null {
	if (shared) return shared.broken ? null : shared;
	if (typeof Worker === 'undefined') return null;
	shared = createPostboxRenderClient(
		() =>
			// Same-origin module script: the web CSP's `worker-src 'self'` and the
			// desktop CSP's `script-src 'self'` fallback both admit it.
			new Worker(new URL('../workers/postboxRender.worker.ts', import.meta.url), {
				type: 'module',
				name: 'postbox-render',
			})
	);
	return shared;
}
