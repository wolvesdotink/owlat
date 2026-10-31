// @vitest-environment happy-dom
//
// Two Blocks with one id. The canvas keys Blocks by id and keeps a
// ref map keyed by id, so a document repeating an id (pasted, imported, an API
// write, a hand-edited template) would send it into "Maximum recursive updates
// exceeded". The builder repairs ids where Blocks enter it: the prop, and
// the explicit `loadState` door. The first occurrence keeps its id.
import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import type { ContainerBlockContent, EditorBlock, TextBlockContent } from '../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

function container(id: string, items: EditorBlock[]): EditorBlock {
	const block = createBlock('container', defaultTheme);
	block.id = id;
	(block.content as ContainerBlockContent).items = items as ContainerBlockContent['items'];
	return block;
}

type Exposed = {
	selectBlock: (id: string) => boolean;
	loadState: (state: { blocks: EditorBlock[]; name: string; subject: string }) => void;
};

let wrapper: VueWrapper | null = null;
let warn: MockInstance;
let error: MockInstance;
/** Errors Vue routed to the app's error handler (a runaway update loop lands here). */
let vueErrors: unknown[] = [];

async function mountBuilder(blocks: EditorBlock[]) {
	wrapper = mount(EmailBuilder, {
		props: { blocks, subject: 'Subject', name: 'Name', variables: [] },
		global: {
			provide: {
				[EmailBuilderHandlersKey as symbol]: {
					uploadImage: async () => ({ url: '', storageId: '' }),
				},
			},
			stubs: { EditorHeader: true, PreviewPanel: true, FloatingBlockSidebar: true },
			config: { errorHandler: (err: unknown) => void vueErrors.push(err) },
		},
		attachTo: document.body,
	});
	await flushPromises();
	return wrapper;
}

/** Every console message Vue wrote about a runaway update loop. */
function recursiveUpdateMessages(): string[] {
	return [...warn.mock.calls, ...error.mock.calls, ...vueErrors.map((err) => [err])]
		.map((call) => call.map(String).join(' '))
		.filter((message) => /recursive updates/i.test(message));
}

function lastEmittedBlocks(w: VueWrapper): EditorBlock[] {
	return (w.emitted('update:blocks')?.at(-1)?.[0] ?? []) as EditorBlock[];
}

function rootIds(w: VueWrapper): string[] {
	return w.findAll('[data-block-id]').map((el) => el.attributes('data-block-id') ?? '');
}

beforeEach(() => {
	vueErrors = [];
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	// Unmount while the console spies still swallow teardown warnings; the
	// setup's own unmount would run after they are restored.
	wrapper?.unmount();
	wrapper = null;
	vi.restoreAllMocks();
});

describe('EmailBuilder with repeated Block ids', () => {
	it('renders two same-id Blocks once each, without an update loop', async () => {
		const w = await mountBuilder([
			text('b1', '<p>First copy</p>'),
			text('b1', '<p>Second copy</p>'),
		]);

		expect(recursiveUpdateMessages()).toEqual([]);
		expect(w.text()).toContain('First copy');
		expect(w.text()).toContain('Second copy');
		const ids = rootIds(w);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe('b1');
		expect(ids[1]).not.toBe('b1');
	});

	it('keeps the two Blocks independently selectable', async () => {
		const w = await mountBuilder([
			text('b1', '<p>First copy</p>'),
			text('b1', '<p>Second copy</p>'),
		]);
		const exposed = w.vm as unknown as Exposed;
		const [, renewed] = rootIds(w);

		expect(exposed.selectBlock(renewed!)).toBe(true);
		await flushPromises();
		let current = w.findAll('[aria-current="true"]');
		expect(current).toHaveLength(1);
		expect(current[0]!.text()).toContain('Second copy');

		expect(exposed.selectBlock('b1')).toBe(true);
		await flushPromises();
		current = w.findAll('[aria-current="true"]');
		expect(current).toHaveLength(1);
		expect(current[0]!.text()).toContain('First copy');
		expect(recursiveUpdateMessages()).toEqual([]);
	});

	it('repairs a document the host swaps in through the prop', async () => {
		const w = await mountBuilder([text('a', '<p>Original</p>')]);

		await w.setProps({
			blocks: [text('b1', '<p>Pasted one</p>'), text('b1', '<p>Pasted two</p>')],
		});
		await flushPromises();

		expect(recursiveUpdateMessages()).toEqual([]);
		expect(w.text()).toContain('Pasted one');
		expect(w.text()).toContain('Pasted two');
		const ids = rootIds(w);
		expect(ids[0]).toBe('b1');
		expect(new Set(ids).size).toBe(2);

		// The repaired document round-trips to the host, so a save persists it.
		const emitted = lastEmittedBlocks(w);
		expect(emitted.map((b) => b.id)).toEqual(ids);
		expect(emitted.map((b) => (b.content as TextBlockContent).html)).toEqual([
			'<p>Pasted one</p>',
			'<p>Pasted two</p>',
		]);
	});

	it('treats a re-pushed copy of the same stored document as its own echo', async () => {
		// The host's live query re-parses the stored document (still repeating
		// the id until the next save) into a fresh array. The repair is
		// deterministic, so it still matches what the builder emitted and does
		// not re-seed the canvas over the user's edits.
		const stored = () => [text('b1', '<p>First copy</p>'), text('b1', '<p>Second copy</p>')];
		const w = await mountBuilder(stored());
		const exposed = w.vm as unknown as Exposed;
		const ids = rootIds(w);

		exposed.loadState({
			blocks: [text(ids[0]!, '<p>First copy</p>'), text(ids[1]!, '<p>Unsaved edit</p>')],
			name: 'Name',
			subject: 'Subject',
		});
		await flushPromises();
		await w.setProps({ blocks: stored() });
		await flushPromises();

		expect(w.text()).toContain('Unsaved edit');
		expect(rootIds(w)).toEqual(ids);
	});

	it('repairs a snapshot loaded through loadState', async () => {
		const w = await mountBuilder([text('a', '<p>Current</p>')]);

		(w.vm as unknown as Exposed).loadState({
			blocks: [text('b1', '<p>Restored one</p>'), text('b1', '<p>Restored two</p>')],
			name: 'Name',
			subject: 'Subject',
		});
		await flushPromises();

		expect(recursiveUpdateMessages()).toEqual([]);
		expect(w.text()).toContain('Restored one');
		expect(w.text()).toContain('Restored two');
		expect(new Set(rootIds(w)).size).toBe(2);
		expect(new Set(lastEmittedBlocks(w).map((b) => b.id)).size).toBe(2);
	});

	it('repairs a nested Block repeating a root id, and fills a missing one', async () => {
		const idless = text('x', '<p>No id</p>');
		delete (idless as { id?: string }).id;
		const w = await mountBuilder([text('a', '<p>Original</p>')]);
		await w.setProps({
			blocks: [
				text('b1', '<p>Root copy</p>'),
				container('box', [text('b1', '<p>Nested copy</p>'), idless]),
			],
		});
		await flushPromises();

		expect(recursiveUpdateMessages()).toEqual([]);
		const [root, box] = lastEmittedBlocks(w);
		const items = (box!.content as ContainerBlockContent).items as EditorBlock[];
		expect(root!.id).toBe('b1');
		expect(items.map((item) => (item.content as TextBlockContent).html)).toEqual([
			'<p>Nested copy</p>',
			'<p>No id</p>',
		]);
		const all = ['b1', 'box', ...items.map((item) => item.id)];
		for (const id of all) expect(id).toBeTypeOf('string');
		expect(new Set(all).size).toBe(all.length);
	});
});
