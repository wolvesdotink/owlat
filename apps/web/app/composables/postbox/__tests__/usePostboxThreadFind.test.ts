/**
 * Find in conversation's controller (usePostboxThreadFind), over the real
 * index with the network and the render worker replaced:
 *   - a word only in a collapsed envelope is found, and stepping to it opens
 *     that message and asks its body to scroll to it;
 *   - a match in a folded quote asks the body to show the quote;
 *   - Enter / Shift+Enter wrap around, and the position survives more
 *     messages arriving (a reply, an earlier page) without moving to another
 *     occurrence;
 *   - a new query, a thread switch and closing each start clean, and a body
 *     answer for the previous thread lands nowhere;
 *   - a search result opens find on its message, without taking the keyboard;
 *   - ⌘F reaches only the reader that answers it;
 *   - each body is scanned once per query, however many settle after it.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { renderPostboxBodyStage } from '~/utils/postboxRenderPipeline';
import type { ResolvedPostboxBody } from '../postboxBodyResolver';
import { createPostboxFindIndex, type PostboxFindRow } from '../postboxFindIndex';
import { usePostboxThreadFind, type PostboxFindSeed } from '../usePostboxThreadFind';
import { countPostboxFindMatches } from '~/utils/postboxFindHighlights';
import type * as FindHighlights from '~/utils/postboxFindHighlights';

// Counted, not replaced: the body scans are the work a long thread must not
// repeat for every body that settles.
vi.mock('~/utils/postboxFindHighlights', async (importOriginal) => {
	const actual = await importOriginal<typeof FindHighlights>();
	return { ...actual, countPostboxFindMatches: vi.fn(actual.countPostboxFindMatches) };
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

type Find = ReturnType<typeof usePostboxThreadFind>;

function setup(
	initial: PostboxFindRow[],
	options: { seed?: PostboxFindSeed | null; answers?: boolean; unsearchable?: string[] } = {}
) {
	const rows = shallowRef<PostboxFindRow[]>(initial);
	const thread = ref('t1');
	const expanded = ref(new Set<string>());
	const seed = shallowRef(options.seed ?? null);
	const loads: Array<{ id: string; answer: ReturnType<typeof deferred<ResolvedPostboxBody>> }> = [];
	let loadEarlierCalls = 0;
	const index = createPostboxFindIndex({
		loadBody: (id) => {
			const answer = deferred<ResolvedPostboxBody>();
			loads.push({ id, answer });
			return answer.promise;
		},
		render: (input) => ({
			promise: Promise.resolve(renderPostboxBodyStage(input).html),
			cancel: () => {},
		}),
		parse: (html) => new DOMParser().parseFromString(html, 'text/html'),
	});
	let find!: Find;
	const Host = defineComponent({
		setup() {
			find = usePostboxThreadFind({
				threadKey: () => thread.value,
				messages: () => rows.value,
				searchable: (row) => !options.unsearchable?.includes(row._id),
				isExpanded: (id) => expanded.value.has(id),
				expand: (id) => {
					expanded.value = new Set(expanded.value).add(id);
				},
				pages: {
					hasEarlier: ref(true),
					loadingEarlier: ref(false),
					earlierFailed: ref(false),
					loadEarlier: () => {
						loadEarlierCalls++;
					},
				},
				seed: () => seed.value,
				answersShortcut: () => options.answers ?? true,
				index,
			});
			return () => h('button', { 'data-testid': 'before' }, 'before');
		},
	});
	const wrapper = mount(Host, { attachTo: document.body });
	return {
		wrapper,
		find: () => find,
		rows,
		thread,
		expanded,
		seed,
		loads,
		loadEarlierCalls: () => loadEarlierCalls,
		async answer(id: string, html: string) {
			const load = loads.find((l) => l.id === id);
			load!.answer.resolve({ html, text: null });
			await flushPromises();
		},
	};
}

const html = (id: string, body: string): PostboxFindRow => ({ _id: id, htmlBodyInline: body });
const envelope = (id: string): PostboxFindRow => ({ _id: id });

async function search(find: Find, query: string) {
	find.open(query);
	await flushPromises();
}

describe('usePostboxThreadFind', () => {
	it('finds a word only a collapsed envelope holds, and opens it on the way there', async () => {
		const t = setup([envelope('m1'), html('m2', '<p>Nothing here.</p>')]);
		await search(t.find(), 'January');
		expect(t.find().total.value).toBe(0);
		expect(t.find().coverage.value.pending).toBe(1);
		await t.answer('m1', '<p>The January refund went out.</p>');
		expect(t.find().total.value).toBe(1);
		expect(t.find().activeIndex.value).toBe(0);
		expect(t.expanded.value.has('m1')).toBe(true);
		expect(t.find().findOf('m1')).toMatchObject({
			needle: 'january',
			active: 0,
			forceQuoted: false,
		});
		expect(t.find().findOf('m1')!.reveal).toBeGreaterThan(0);
		expect(t.find().findOf('m2')).toBeNull();
		expect(t.find().matchCountOf('m1')).toBe(1);
	});

	it('shows a folded quote when a match sits in it', async () => {
		const t = setup([
			html('m1', '<p>Refund sent.</p>'),
			html(
				'm2',
				'<p>Thanks!</p><blockquote type="cite"><p>Could you refund the second charge?</p></blockquote>'
			),
		]);
		await search(t.find(), 'refund');
		expect(t.find().total.value).toBe(2);
		expect(t.find().findOf('m1')!.forceQuoted).toBe(false);
		expect(t.find().findOf('m2')!.forceQuoted).toBe(true);
	});

	it('starts at the first match in a message already open on screen', async () => {
		const t = setup([html('m1', '<p>refund</p>'), html('m2', '<p>refund</p>')]);
		t.expanded.value = new Set(['m2']);
		await search(t.find(), 'refund');
		expect(t.find().activeIndex.value).toBe(1);
		// Nothing it did not have to open was opened.
		expect([...t.expanded.value]).toEqual(['m2']);
	});

	it('steps forward and back, wrapping at both ends', async () => {
		const t = setup([html('m1', '<p>refund refund</p>'), html('m2', '<p>refund</p>')]);
		await search(t.find(), 'refund');
		const f = t.find();
		expect(f.activeIndex.value).toBe(0);
		f.next();
		f.next();
		expect(f.activeIndex.value).toBe(2);
		expect(f.findOf('m2')!.active).toBe(0);
		f.next();
		expect(f.activeIndex.value).toBe(0);
		f.previous();
		expect(f.activeIndex.value).toBe(2);
		f.previous();
		expect(f.findOf('m1')!.active).toBe(1);
	});

	it('keeps the active match when more messages arrive, and searches what arrives', async () => {
		const t = setup([html('m2', '<p>refund</p>'), html('m3', '<p>refund</p>')]);
		await search(t.find(), 'refund');
		t.find().next();
		expect(t.find().findOf('m3')!.active).toBe(0);
		// "Search earlier messages" asks the pager; the page arrives as rows.
		t.find().searchEarlier();
		expect(t.loadEarlierCalls()).toBe(1);
		t.rows.value = [envelope('m1'), ...t.rows.value];
		await flushPromises();
		await t.answer('m1', '<p>refund</p>');
		expect(t.find().total.value).toBe(3);
		// Same occurrence, a new position.
		expect(t.find().activeIndex.value).toBe(2);
		expect(t.find().findOf('m3')!.active).toBe(0);
	});

	it('starts over on a new query, and does not index before there is one', async () => {
		const t = setup([envelope('m1'), html('m2', '<p>refund and invoice</p>')]);
		t.find().open();
		await flushPromises();
		expect(t.loads).toHaveLength(0);
		await search(t.find(), 'refund');
		t.find().query.value = 'invoice';
		await flushPromises();
		expect(t.find().activeIndex.value).toBe(0);
		expect(t.find().findOf('m2')).toMatchObject({ needle: 'invoice', active: 0 });
		// The text is the query's no longer: typing never reloads a body.
		expect(t.loads).toHaveLength(1);
	});

	it('drops what it found when the reader moves to another thread', async () => {
		const t = setup([envelope('m1')]);
		await search(t.find(), 'refund');
		t.thread.value = 't2';
		await nextTick();
		expect(t.find().isOpen.value).toBe(false);
		await t.answer('m1', '<p>refund</p>');
		t.find().open('refund');
		await flushPromises();
		// The stale answer was dropped; the new thread reads the body again.
		expect(t.loads.map((l) => l.id)).toEqual(['m1', 'm1']);
		expect(t.find().total.value).toBe(0);
	});

	it('closes clean and hands focus back to where it was', async () => {
		const t = setup([html('m1', '<p>refund</p>')]);
		const before = t.wrapper.get('[data-testid="before"]').element as HTMLButtonElement;
		before.focus();
		await search(t.find(), 'refund');
		const field = document.createElement('input');
		document.body.append(field);
		onTestFinished(() => field.remove());
		field.focus();
		t.find().close();
		expect(t.find().findOf('m1')).toBeNull();
		expect(t.find().matchCountOf('m1')).toBe(0);
		expect(document.activeElement).toBe(before);
	});

	it('opens on a search result’s message first, without taking the keyboard', async () => {
		const t = setup([html('m1', '<p>refund</p>'), envelope('m2')], {
			seed: { query: 'refund', messageId: 'm2' },
		});
		await flushPromises();
		expect(t.find().isOpen.value).toBe(true);
		expect(t.find().focusRequest.value).toBe(0);
		// m1 has a match already, but the result's message goes first.
		expect(t.find().activeIndex.value).toBe(-1);
		await t.answer('m2', '<p>The refund went out.</p>');
		expect(t.find().activeIndex.value).toBe(1);
		expect(t.find().findOf('m2')!.active).toBe(0);
		expect(t.expanded.value.has('m2')).toBe(true);
	});

	it('falls back to the first match when the result’s message holds none', async () => {
		const t = setup([html('m1', '<p>refund</p>'), html('m2', '<p>subject-only hit</p>')], {
			seed: { query: 'refund', messageId: 'm2' },
		});
		await flushPromises();
		expect(t.find().activeIndex.value).toBe(0);
		expect(t.find().findOf('m1')!.active).toBe(0);
	});

	it('counts what it could not search apart from the matches', async () => {
		const t = setup([envelope('m1'), html('m2', '<p>refund</p>'), envelope('m3')], {
			unsearchable: ['m3'],
		});
		await search(t.find(), 'refund');
		expect(t.find().coverage.value).toEqual({ pending: 1, failed: 0, unsearchable: 1 });
		t.loads[0]!.answer.resolve(null);
		await flushPromises();
		expect(t.find().coverage.value).toEqual({ pending: 0, failed: 1, unsearchable: 1 });
		t.find().retry();
		expect(t.loads.map((l) => l.id)).toEqual(['m1', 'm1']);
	});

	it('opens on ⌘F, and only in the reader that answers it', async () => {
		const t = setup([html('m1', '<p>refund</p>')]);
		await nextTick();
		const press = () => {
			const event = new KeyboardEvent('keydown', {
				key: 'f',
				ctrlKey: true,
				bubbles: true,
				cancelable: true,
			});
			document.body.dispatchEvent(event);
			return event;
		};
		const event = press();
		expect(event.defaultPrevented).toBe(true);
		expect(t.find().isOpen.value).toBe(true);
		expect(t.find().focusRequest.value).toBe(1);
		t.wrapper.unmount();

		const other = setup([html('m1', '<p>refund</p>')], { answers: false });
		await nextTick();
		expect(press().defaultPrevented).toBe(false);
		expect(other.find().isOpen.value).toBe(false);
	});

	it('scans each body once per query as the bodies settle one by one', async () => {
		const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
		const t = setup(ids.map(envelope));
		await search(t.find(), 'refund');
		vi.mocked(countPostboxFindMatches).mockClear();
		for (const id of ids) await t.answer(id, '<p>refund</p>');
		expect(t.find().total.value).toBe(20);
		expect(t.find().coverage.value.pending).toBe(0);
		expect(vi.mocked(countPostboxFindMatches)).toHaveBeenCalledTimes(20);
		// A new query reads every body once more, and nothing else does.
		t.find().query.value = 'invoice';
		await flushPromises();
		t.find().next();
		expect(vi.mocked(countPostboxFindMatches)).toHaveBeenCalledTimes(40);
	});
});
