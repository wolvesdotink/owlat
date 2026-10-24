/**
 * The shared render-worker client: lazy creation, one request in flight,
 * cancellation, and failure that always settles (never a request left
 * waiting on a worker that cannot answer).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPostboxRenderClient, type PostboxRenderWorkerPort } from '../postboxRenderWorker';
import type {
	PostboxRenderStageInput,
	PostboxRenderWorkerRequest,
	PostboxRenderWorkerResponse,
} from '~/utils/postboxRenderPipeline';

class FakeWorker implements PostboxRenderWorkerPort {
	readonly requests: PostboxRenderWorkerRequest[] = [];
	readonly listeners = new Map<string, ((event: Event) => void)[]>();
	terminated = false;

	postMessage(request: PostboxRenderWorkerRequest): void {
		this.requests.push(request);
	}

	addEventListener(type: string, listener: (event: never) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener as (event: Event) => void);
		this.listeners.set(type, list);
	}

	terminate(): void {
		this.terminated = true;
	}

	emit(type: string, data?: unknown): void {
		const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type);
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	answer(request: PostboxRenderWorkerRequest, html = `out:${request.input.html}`): void {
		const response: PostboxRenderWorkerResponse = {
			id: request.id,
			ok: true,
			output: { html, scheme: 'light', kind: 'simple', hasQuote: false },
		};
		this.emit('message', response);
	}
}

function input(html: string): PostboxRenderStageInput {
	return { html, text: '', showQuoted: false, scheme: 'light', cidUrls: new Map() };
}

function setup() {
	const workers: FakeWorker[] = [];
	const createWorker = vi.fn(() => {
		const worker = new FakeWorker();
		workers.push(worker);
		return worker;
	});
	return { client: createPostboxRenderClient(createWorker), createWorker, workers };
}

describe('createPostboxRenderClient', () => {
	it('creates the worker on the first request, once', async () => {
		const { client, createWorker, workers } = setup();
		expect(createWorker).not.toHaveBeenCalled();
		const first = client.render(input('a'));
		const second = client.render(input('b'));
		expect(createWorker).toHaveBeenCalledTimes(1);

		const worker = workers[0]!;
		worker.answer(worker.requests[0]!);
		await expect(first.promise).resolves.toMatchObject({ html: 'out:a' });
		worker.answer(worker.requests[1]!);
		await expect(second.promise).resolves.toMatchObject({ html: 'out:b' });
		expect(createWorker).toHaveBeenCalledTimes(1);
	});

	it('posts one request at a time, in order', () => {
		const { client, workers } = setup();
		client.render(input('a'));
		client.render(input('b'));
		const worker = workers[0]!;
		expect(worker.requests.map((r) => r.input.html)).toEqual(['a']);
		worker.answer(worker.requests[0]!);
		expect(worker.requests.map((r) => r.input.html)).toEqual(['a', 'b']);
	});

	it('never posts a request cancelled while it waits', () => {
		const { client, workers } = setup();
		client.render(input('a'));
		client.render(input('stale')).cancel();
		client.render(input('c'));
		const worker = workers[0]!;
		worker.answer(worker.requests[0]!);
		expect(worker.requests.map((r) => r.input.html)).toEqual(['a', 'c']);
	});

	it('drops the answer to a request cancelled in flight and moves on', async () => {
		const { client, workers } = setup();
		const first = client.render(input('a'));
		const onSettled = vi.fn();
		first.promise.then(onSettled, onSettled);
		const second = client.render(input('b'));
		first.cancel();
		const worker = workers[0]!;
		worker.answer(worker.requests[0]!);
		worker.answer(worker.requests[1]!);
		await expect(second.promise).resolves.toMatchObject({ html: 'out:b' });
		expect(onSettled).not.toHaveBeenCalled();
	});

	it('ignores an answer that is not for the request in flight', async () => {
		const { client, workers } = setup();
		const job = client.render(input('a'));
		const worker = workers[0]!;
		worker.emit('message', { id: 999, ok: true, output: { html: 'x' } });
		worker.answer(worker.requests[0]!);
		await expect(job.promise).resolves.toMatchObject({ html: 'out:a' });
	});

	it('rejects only the request whose render threw', async () => {
		const { client, workers } = setup();
		const failing = client.render(input('bad'));
		const next = client.render(input('good'));
		const worker = workers[0]!;
		worker.emit('message', { id: worker.requests[0]!.id, ok: false, error: 'boom' });
		await expect(failing.promise).rejects.toThrow('boom');
		worker.answer(worker.requests[1]!);
		await expect(next.promise).resolves.toMatchObject({ html: 'out:good' });
		expect(client.broken).toBe(false);
	});

	it('rejects the request in flight when its answer cannot be read', async () => {
		const { client, workers } = setup();
		const lost = client.render(input('a'));
		const next = client.render(input('b'));
		const worker = workers[0]!;
		worker.emit('messageerror');
		await expect(lost.promise).rejects.toThrow();
		worker.answer(worker.requests[1]!);
		await expect(next.promise).resolves.toMatchObject({ html: 'out:b' });
	});

	it('settles everything and stays broken once the worker fails', async () => {
		const { client, workers, createWorker } = setup();
		const inFlight = client.render(input('a'));
		const queued = client.render(input('b'));
		const cancelled = client.render(input('c'));
		cancelled.cancel();
		const onCancelled = vi.fn();
		cancelled.promise.then(onCancelled, onCancelled);
		const worker = workers[0]!;
		worker.emit('error');
		await expect(inFlight.promise).rejects.toThrow();
		await expect(queued.promise).rejects.toThrow();
		expect(worker.terminated).toBe(true);
		expect(client.broken).toBe(true);
		await expect(client.render(input('d')).promise).rejects.toThrow();
		expect(createWorker).toHaveBeenCalledTimes(1);
		expect(onCancelled).not.toHaveBeenCalled();
	});

	it('settles the request when the worker cannot be created', async () => {
		const client = createPostboxRenderClient(() => {
			throw new Error('blocked by policy');
		});
		await expect(client.render(input('a')).promise).rejects.toThrow('blocked by policy');
		expect(client.broken).toBe(true);
	});
});

describe('getPostboxRenderClient', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it('is null where no Worker exists, so bodies render on the main thread', async () => {
		vi.stubGlobal('Worker', undefined);
		const { getPostboxRenderClient } = await import('../postboxRenderWorker');
		expect(getPostboxRenderClient()).toBeNull();
	});

	it('starts one same-origin module worker for the tab, and drops it once broken', async () => {
		const created: { worker: FakeWorker; url: string; options: WorkerOptions }[] = [];
		const WorkerStub = vi.fn(function (url: URL, options: WorkerOptions) {
			const worker = new FakeWorker();
			created.push({ worker, url: String(url), options });
			return worker;
		});
		vi.stubGlobal('Worker', WorkerStub);
		const { getPostboxRenderClient } = await import('../postboxRenderWorker');
		const client = getPostboxRenderClient();
		expect(client).not.toBeNull();
		expect(getPostboxRenderClient()).toBe(client);
		expect(WorkerStub).not.toHaveBeenCalled();

		const job = client!.render(input('a'));
		expect(WorkerStub).toHaveBeenCalledTimes(1);
		// Vite rewrites the URL for its worker bundle (`?worker_file`), which is the
		// proof it recognised the constructor and will emit the worker.
		expect(created[0]!.url).toMatch(/\/workers\/postboxRender\.worker\.ts\?worker_file/);
		expect(created[0]!.options).toMatchObject({ type: 'module' });
		created[0]!.worker.emit('error');
		await expect(job.promise).rejects.toThrow();
		expect(getPostboxRenderClient()).toBeNull();
	});
});
