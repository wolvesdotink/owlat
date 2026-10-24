/**
 * PostboxMessageBody renders through the shared render worker. A fake worker
 * holds every request until the test answers it (with the real pipeline), so
 * each state between "requested" and "shown" can be inspected:
 *   - the skeleton holds the space, and nothing is saved, cached or reported;
 *   - an answer for a body that is no longer current is dropped;
 *   - a re-opened message is a cache hit that never reaches the worker;
 *   - a dead worker or a failed render still settles, on the main thread.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { ref } from 'vue';

import PostboxMessageBody from '../PostboxMessageBody.vue';
import PostboxReaderSkeleton from '../PostboxReaderSkeleton.vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import { getPostboxRenderCache } from '../../../utils/postboxRenderCache';
import {
	renderPostboxBodyStage,
	type PostboxRenderWorkerRequest,
} from '~/utils/postboxRenderPipeline';
import {
	createPostboxRenderClient,
	type PostboxRenderClient,
	type PostboxRenderWorkerPort,
} from '../../../lib/postboxRenderWorker';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

let client: PostboxRenderClient;
vi.mock('../../../lib/postboxRenderWorker', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/postboxRenderWorker')>();
	return { ...actual, getPostboxRenderClient: () => (client.broken ? null : client) };
});

class FakeWorker implements PostboxRenderWorkerPort {
	readonly requests: PostboxRenderWorkerRequest[] = [];
	private readonly listeners = new Map<string, ((event: Event) => void)[]>();

	postMessage(request: PostboxRenderWorkerRequest): void {
		this.requests.push(request);
	}

	addEventListener(type: string, listener: (event: never) => void): void {
		this.listeners.set(type, [
			...(this.listeners.get(type) ?? []),
			listener as (event: Event) => void,
		]);
	}

	terminate(): void {}

	emit(type: string, data?: unknown): void {
		const event = type === 'message' ? new MessageEvent('message', { data }) : new Event(type);
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	/** Answer a request the way the real worker does. */
	answer(request: PostboxRenderWorkerRequest): void {
		this.emit('message', {
			id: request.id,
			ok: true,
			output: renderPostboxBodyStage(request.input),
		});
	}
}

let workers: FakeWorker[] = [];
const persistBody = vi.fn(async (_id: string, _srcdoc: string) => {});

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), error: ref(null) }));
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.stubGlobal('usePostboxOfflineCache', () => ({
		isOffline: ref(false),
		persistBody,
		loadBody: vi.fn(async () => null),
	}));
});

const mounted: VueWrapper[] = [];

beforeEach(() => {
	getPostboxRenderCache().clear();
	persistBody.mockClear();
	workers = [];
	client = createPostboxRenderClient(() => {
		const worker = new FakeWorker();
		workers.push(worker);
		return worker;
	});
});

afterEach(() => {
	for (const w of mounted.splice(0)) w.unmount();
});

const iconStub = { props: ['name'], template: '<span />' };

type BodyProps = InstanceType<typeof PostboxMessageBody>['$props'];

function mountBody(props: BodyProps) {
	const w = mount(PostboxMessageBody, {
		props,
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderSkeleton, UiSkeleton, Icon: iconStub },
			stubs: { PostboxImageBanner: true },
		},
	});
	mounted.push(w);
	return w;
}

const HOSTILE = {
	_id: 'msg-a',
	htmlBodyInline: '<p onclick="steal()">Hello A</p><script>x()</script>',
};
const OTHER = { _id: 'msg-b', htmlBodyInline: '<p>Hello B</p>' };

function srcdoc(w: VueWrapper): string {
	return w.find('iframe').attributes('srcdoc') ?? '';
}

function pendingRequests(): PostboxRenderWorkerRequest[] {
	return workers.flatMap((worker) => worker.requests);
}

describe('PostboxMessageBody render worker', () => {
	it('shows the skeleton and saves nothing until the worker answers', async () => {
		const w = mountBody({ message: HOSTILE });
		await flushPromises();

		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(true);
		expect(w.find('iframe').exists()).toBe(false);
		expect(persistBody).not.toHaveBeenCalled();
		expect(w.emitted('trackers')).toBeUndefined();
		expect(w.emitted('imageState')).toBeUndefined();
		expect(pendingRequests()).toHaveLength(1);

		workers[0]!.answer(pendingRequests()[0]!);
		await flushPromises();

		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		expect(srcdoc(w)).toContain('Hello A');
		expect(srcdoc(w)).not.toMatch(/onclick|<script/);
		expect(persistBody).toHaveBeenCalledTimes(1);
		expect(persistBody).toHaveBeenCalledWith('msg-a', srcdoc(w));
		expect(w.emitted('trackers')).toHaveLength(1);
		expect(w.emitted('imageState')).toEqual([['none']]);
	});

	it('drops the answer for a message the reader has moved past', async () => {
		const w = mountBody({ message: HOSTILE });
		await flushPromises();
		await w.setProps({ message: OTHER });
		await flushPromises();

		// The worker finishes the first message after the switch: never shown.
		workers[0]!.answer(pendingRequests()[0]!);
		await flushPromises();
		expect(w.find('iframe').exists()).toBe(false);
		expect(persistBody).not.toHaveBeenCalled();
		expect(getPostboxRenderCache().size).toBe(0);

		expect(pendingRequests()).toHaveLength(2);
		workers[0]!.answer(pendingRequests()[1]!);
		await flushPromises();
		expect(srcdoc(w)).toContain('Hello B');
		expect(srcdoc(w)).not.toContain('Hello A');
		expect(persistBody.mock.calls.map(([id]) => id)).toEqual(['msg-b']);
	});

	it('ignores an answer that arrives after unmount', async () => {
		const w = mountBody({ message: HOSTILE });
		await flushPromises();
		w.unmount();
		mounted.splice(0);

		workers[0]!.answer(pendingRequests()[0]!);
		await flushPromises();
		expect(persistBody).not.toHaveBeenCalled();
		expect(getPostboxRenderCache().size).toBe(0);
	});

	it('keeps the shown document while the same body re-renders', async () => {
		const quoted = {
			_id: 'msg-q',
			htmlBodyInline: '<p>Fresh</p><blockquote><p>Earlier</p></blockquote>',
		};
		const w = mountBody({ message: quoted });
		await flushPromises();
		workers[0]!.answer(pendingRequests()[0]!);
		await flushPromises();
		expect(srcdoc(w)).not.toContain('Earlier');

		await w.find('button').trigger('click');
		await flushPromises();
		expect(pendingRequests()).toHaveLength(2);
		expect(w.findComponent(PostboxReaderSkeleton).exists()).toBe(false);
		expect(srcdoc(w)).toContain('Fresh');

		workers[0]!.answer(pendingRequests()[1]!);
		await flushPromises();
		expect(srcdoc(w)).toContain('Earlier');
	});

	it('serves a re-opened message from the cache without a worker request', async () => {
		const first = mountBody({ message: OTHER });
		await flushPromises();
		workers[0]!.answer(pendingRequests()[0]!);
		await flushPromises();
		const shown = srcdoc(first);
		first.unmount();
		mounted.splice(0);

		const again = mountBody({ message: OTHER });
		expect(srcdoc(again)).toBe(shown);
		await flushPromises();
		expect(pendingRequests()).toHaveLength(1);
	});

	it('applies image consent without asking the worker again', async () => {
		const message = {
			_id: 'msg-img',
			htmlBodyInline:
				'<p>Look</p><img src="https://cdn.example/photo.jpg" width="300" height="200">',
		};
		const w = mountBody({ message, autoLoadImages: false });
		await flushPromises();
		workers[0]!.answer(pendingRequests()[0]!);
		await flushPromises();
		expect(srcdoc(w)).not.toContain('src="https://cdn.example/photo.jpg"');

		await w.setProps({ autoLoadImages: true });
		await flushPromises();
		expect(pendingRequests()).toHaveLength(1);
		expect(srcdoc(w)).toContain('src="https://cdn.example/photo.jpg"');
	});

	it('renders on the main thread once the worker dies, and keeps doing so', async () => {
		const w = mountBody({ message: HOSTILE });
		await flushPromises();
		workers[0]!.emit('error');
		await flushPromises();
		expect(srcdoc(w)).toContain('Hello A');
		expect(srcdoc(w)).not.toMatch(/onclick|<script/);
		expect(persistBody).toHaveBeenCalledTimes(1);

		const next = mountBody({ message: OTHER });
		expect(srcdoc(next)).toContain('Hello B');
		expect(workers).toHaveLength(1);
	});

	it('renders on the main thread when the worker reports a failed render', async () => {
		const w = mountBody({ message: OTHER });
		await flushPromises();
		const request = pendingRequests()[0]!;
		workers[0]!.emit('message', { id: request.id, ok: false, error: 'boom' });
		await flushPromises();
		expect(srcdoc(w)).toContain('Hello B');
		expect(client.broken).toBe(false);
	});
});
