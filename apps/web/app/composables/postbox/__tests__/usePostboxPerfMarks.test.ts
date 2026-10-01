// @vitest-environment happy-dom
/**
 * The Postbox's two plan-0.2 timings: an open until the opened message's body
 * is on screen, and back-to-list until the list shows its rows. Each case runs
 * against the real `usePerfMark` and telemetry module, armed with a recording
 * sender, so it sees exactly what would reach PostHog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';

import type * as MarksModule from '../usePostboxPerfMarks';

type Marks = typeof MarksModule;
type Guard = (
	to: { name: string; params: Record<string, string> },
	from: { name: string; params: Record<string, string> }
) => void;

const PAGE = 'dashboard-postbox-folder-messageId';
const route = (folder: string, messageId?: string, name = PAGE) => ({
	name,
	params: messageId ? { folder, messageId } : { folder },
});

let sent: Array<[string, Record<string, unknown>]>;
let guard: Guard | null;
let removeGuard: ReturnType<typeof vi.fn>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let scope: EffectScope | null;

function runFrame(): void {
	const due = [...frames.values()];
	frames = new Map();
	for (const cb of due) cb(0);
}

async function load(): Promise<Marks> {
	vi.resetModules();
	const telemetry = await import('~/lib/perfTelemetry');
	telemetry.armPerfReporting({ currentRoute: () => 'dashboard-postbox-folder' });
	telemetry.setPerfSender((event, properties) => sent.push([event, properties]));
	return import('../usePostboxPerfMarks');
}

/** The layout's wiring, in a scope the case can dispose. */
function mountMarks(marks: Marks) {
	const activeMessageId = ref<string | null>(null);
	const listPane = ref<HTMLElement | null>(document.createElement('section'));
	scope = effectScope();
	scope.run(() =>
		marks.usePostboxPerfMarks({ activeMessageId: () => activeMessageId.value, listPane })
	);
	return { activeMessageId, listPane };
}

/** A navigation as the router runs it: the guard, then the page's new props. */
async function navigate(
	to: ReturnType<typeof route>,
	from: ReturnType<typeof route>,
	activeMessageId: { value: string | null }
): Promise<void> {
	guard!(to, from);
	activeMessageId.value = to.params.messageId ?? null;
	await nextTick();
}

function paneWith(html: string): HTMLElement {
	const pane = document.createElement('section');
	pane.innerHTML = html;
	return pane;
}

const SKELETON = '<ul data-testid="postbox-thread-list-skeleton"></ul>';
const ROWS = '<ul role="listbox"><li><a role="option">Row</a></li></ul>';

beforeEach(() => {
	sent = [];
	guard = null;
	removeGuard = vi.fn();
	frames = new Map();
	nextFrame = 1;
	scope = null;
	performance.clearMarks();
	performance.clearMeasures();
	vi.stubGlobal('useRouter', () => ({
		beforeEach: (fn: Guard) => {
			guard = fn;
			return removeGuard;
		},
	}));
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		const id = nextFrame++;
		frames.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
	scope?.stop();
	vi.unstubAllGlobals();
});

describe('classifyPostboxNav', () => {
	it('calls a move to another message an open, from the list or from the reader', async () => {
		const { classifyPostboxNav } = await load();
		expect(classifyPostboxNav(route('inbox', 'm1'), route('inbox'))).toBe('open');
		expect(classifyPostboxNav(route('inbox', 'm2'), route('inbox', 'm1'))).toBe('open');
	});

	it('calls reader-to-list of the same folder a back', async () => {
		const { classifyPostboxNav } = await load();
		expect(classifyPostboxNav(route('inbox'), route('inbox', 'm1'))).toBe('back');
	});

	it('times neither a folder switch, the same message, nor another page', async () => {
		const { classifyPostboxNav } = await load();
		expect(classifyPostboxNav(route('archive'), route('inbox', 'm1'))).toBeNull();
		expect(classifyPostboxNav(route('inbox'), route('archive'))).toBeNull();
		expect(classifyPostboxNav(route('inbox', 'm1'), route('inbox', 'm1'))).toBeNull();
		expect(
			classifyPostboxNav(route('inbox', 'm1'), route('inbox', undefined, 'dashboard-chat'))
		).toBeNull();
	});
});

describe('postboxListRendered', () => {
	it('is ready with rows, not with the first-load skeleton, and ready when settled empty', async () => {
		const { postboxListRendered } = await load();
		expect(postboxListRendered(paneWith(SKELETON))).toBe(false);
		expect(postboxListRendered(paneWith(ROWS))).toBe(true);
		expect(postboxListRendered(paneWith('<p>Nothing here</p>'))).toBe(true);
	});
});

describe('reader open timing', () => {
	it('reports once, when the opened message body renders, and ignores other bodies', async () => {
		const marks = await load();
		const { activeMessageId } = mountMarks(marks);

		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);
		// Another message of the thread renders first: not the one that was opened.
		marks.notePostboxBodyRendered('m0');
		expect(sent).toEqual([]);

		marks.notePostboxBodyRendered('m1');
		marks.notePostboxBodyRendered('m1');
		expect(sent).toHaveLength(1);
		expect(sent[0]?.[0]).toBe('owlat_reader_open_ms');
		expect(sent[0]?.[1]).toMatchObject({ route: 'dashboard-postbox-folder' });
		expect(typeof sent[0]?.[1]['duration_ms']).toBe('number');
	});

	it('starts the span at the click that asked for the open', async () => {
		const marks = await load();
		const { activeMessageId } = mountMarks(marks);

		const click = new MouseEvent('click', { bubbles: true });
		document.body.dispatchEvent(click);
		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);

		const start = performance.getEntriesByName('owlat_reader_open_start', 'mark').at(-1);
		expect(start?.startTime).toBe(click.timeStamp);
	});

	it('keeps timing through a query-only change and drops it on a folder switch', async () => {
		const marks = await load();
		const { activeMessageId } = mountMarks(marks);

		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);
		guard!(route('inbox', 'm1'), route('inbox', 'm1'));
		marks.notePostboxBodyRendered('m1');
		expect(sent.map(([event]) => event)).toEqual(['owlat_reader_open_ms']);

		await navigate(route('inbox', 'm2'), route('inbox', 'm1'), activeMessageId);
		await navigate(route('archive'), route('inbox', 'm2'), activeMessageId);
		marks.notePostboxBodyRendered('m2');
		expect(sent).toHaveLength(1);
	});

	it('forgets a pending open and removes its guard when the layout goes', async () => {
		const marks = await load();
		const { activeMessageId } = mountMarks(marks);

		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);
		scope!.stop();
		scope = null;
		marks.notePostboxBodyRendered('m1');

		expect(sent).toEqual([]);
		expect(removeGuard).toHaveBeenCalledOnce();
	});
});

describe('back-to-list timing', () => {
	it('waits for the rows, then reports once', async () => {
		const marks = await load();
		const { activeMessageId, listPane } = mountMarks(marks);
		listPane.value = paneWith(SKELETON);

		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);
		await navigate(route('inbox'), route('inbox', 'm1'), activeMessageId);
		runFrame();
		expect(sent.filter(([event]) => event === 'owlat_back_list_ms')).toEqual([]);

		listPane.value = paneWith(ROWS);
		runFrame();
		runFrame();
		const back = sent.filter(([event]) => event === 'owlat_back_list_ms');
		expect(back).toHaveLength(1);
		expect(frames.size).toBe(0);
	});

	it('does not time a folder switch out of the reader', async () => {
		const marks = await load();
		const { activeMessageId, listPane } = mountMarks(marks);
		listPane.value = paneWith(ROWS);

		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);
		await navigate(route('archive'), route('inbox', 'm1'), activeMessageId);
		runFrame();

		expect(sent).toEqual([]);
	});

	it('stops waiting when the next message opens before the rows arrive', async () => {
		const marks = await load();
		const { activeMessageId, listPane } = mountMarks(marks);
		listPane.value = paneWith(SKELETON);

		await navigate(route('inbox', 'm1'), route('inbox'), activeMessageId);
		await navigate(route('inbox'), route('inbox', 'm1'), activeMessageId);
		await navigate(route('inbox', 'm2'), route('inbox'), activeMessageId);
		listPane.value = paneWith(ROWS);
		runFrame();

		expect(sent.filter(([event]) => event === 'owlat_back_list_ms')).toEqual([]);
	});
});
