// @vitest-environment happy-dom
//
// The Undo and Redo buttons render from the builder's history flags, so they
// have to follow the committed history: the first edit is undoable once it
// commits, and a host's loadState does not swallow an edit still inside the
// history debounce into the loaded state.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import { HISTORY_DEBOUNCE_MS } from '../../constants';
import type { EditorBlock, TextBlockContent } from '../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

let wrapper: VueWrapper | null = null;

async function mountBuilder() {
	wrapper = mount(EmailBuilder, {
		props: {
			blocks: [text('b-1', '<p>Body</p>')],
			subject: 'Subject',
			name: 'Name',
			variables: [],
		},
		global: {
			provide: {
				[EmailBuilderHandlersKey as symbol]: {
					uploadImage: async () => ({ url: '', storageId: '' }),
				},
			},
			stubs: { EditorHeader: true, PreviewPanel: true, FloatingBlockSidebar: true },
		},
	});
	await flushPromises();
	// Timers are faked only after mount, so the debounce is driven by the test.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	return wrapper;
}

async function tick() {
	await nextTick();
	await nextTick();
}

async function settleHistory() {
	await tick();
	vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
	await tick();
}

function header(w: VueWrapper) {
	return w.findComponent({ name: 'EditorHeader' });
}

function buttons(w: VueWrapper) {
	return { canUndo: header(w).props('canUndo'), canRedo: header(w).props('canRedo') };
}

afterEach(() => {
	vi.useRealTimers();
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder undo/redo availability', () => {
	it('enables Undo after the first edit commits, and Undo restores the original', async () => {
		const w = await mountBuilder();
		expect(buttons(w)).toEqual({ canUndo: false, canRedo: false });

		header(w).vm.$emit('update:name', 'Renamed');
		await settleHistory();
		expect(buttons(w)).toEqual({ canUndo: true, canRedo: false });

		header(w).vm.$emit('undo');
		await settleHistory();
		expect(w.emitted('update:name')?.at(-1)).toEqual(['Name']);
		expect(buttons(w)).toEqual({ canUndo: false, canRedo: true });
	});

	it('disables Redo once an edit follows an undo', async () => {
		const w = await mountBuilder();
		header(w).vm.$emit('update:name', 'B');
		await settleHistory();
		header(w).vm.$emit('update:name', 'C');
		await settleHistory();
		header(w).vm.$emit('undo');
		await settleHistory();
		expect(buttons(w)).toEqual({ canUndo: true, canRedo: true });

		header(w).vm.$emit('update:name', 'D');
		await settleHistory();
		expect(buttons(w)).toEqual({ canUndo: true, canRedo: false });

		header(w).vm.$emit('redo');
		await settleHistory();
		expect(w.emitted('update:name')?.at(-1)).toEqual(['D']);
	});

	it('keeps an edit pending in the debounce as its own step when loadState runs', async () => {
		const w = await mountBuilder();
		header(w).vm.$emit('update:name', 'Typed');
		await tick();

		(w.vm as unknown as { loadState: (s: unknown) => void }).loadState({
			blocks: [text('b-1', '<p>Loaded</p>')],
			name: 'Loaded name',
			subject: 'Subject',
		});
		await settleHistory();

		header(w).vm.$emit('undo');
		await settleHistory();
		// One undo steps back over the load only, not over the typed name too.
		expect(w.emitted('update:name')?.at(-1)).toEqual(['Typed']);
		expect(buttons(w)).toEqual({ canUndo: true, canRedo: true });
	});
});
