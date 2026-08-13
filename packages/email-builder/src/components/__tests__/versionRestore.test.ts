// @vitest-environment happy-dom
//
// Restoring a version has to reach the canvas.
//
// The builder syncs `props.blocks` into its own canvas state through a watcher
// that ignores an incoming array carrying the same block ids as the one it last
// emitted — the host's live query echoes the saved document back while the user
// keeps typing, and re-seeding from that echo would drop the in-flight edits.
// A restored snapshot keeps the block ids and changes only their content, so it
// is indistinguishable from that echo: pushed through the prop it is silently
// dropped, and the canvas keeps showing the current copy while a save would
// persist the restored one. `loadState` is the explicit door for that case.
import { describe, it, expect, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import type { EditorBlock, TextBlockContent } from '../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

let wrapper: VueWrapper | null = null;

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
		},
	});
	await flushPromises();
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder version restore', () => {
	it('renders a same-ids/different-content snapshot pushed through loadState', async () => {
		const w = await mountBuilder([text('b-1', '<p>Current copy</p>')]);
		expect(w.text()).toContain('Current copy');

		const restored = [text('b-1', '<p>Yesterday copy</p>')];
		(w.vm as unknown as { loadState: (s: unknown) => void }).loadState({
			blocks: restored,
			name: 'Restored name',
			subject: 'Restored subject',
		});
		await flushPromises();

		expect(w.text()).toContain('Yesterday copy');
		expect(w.text()).not.toContain('Current copy');
		// The restore round-trips back to the host, so a save persists what the
		// canvas shows.
		expect((w.emitted('update:blocks')?.at(-1)?.[0] as EditorBlock[])[0]).toMatchObject({
			id: 'b-1',
		});
		expect(w.emitted('update:name')?.at(-1)).toEqual(['Restored name']);
		expect(w.emitted('update:subject')?.at(-1)).toEqual(['Restored subject']);
	});

	it('adds and removes blocks from the same snapshot', async () => {
		const w = await mountBuilder([text('b-1', '<p>Only block</p>')]);

		(w.vm as unknown as { loadState: (s: unknown) => void }).loadState({
			blocks: [text('b-2', '<p>Alpha</p>'), text('b-3', '<p>Beta</p>')],
			name: 'Name',
			subject: 'Subject',
		});
		await flushPromises();

		expect(w.text()).toContain('Alpha');
		expect(w.text()).toContain('Beta');
		expect(w.text()).not.toContain('Only block');
	});

	it('still ignores a same-ids echo arriving through the prop', async () => {
		// The guard this test pins is why loadState exists: the host's live query
		// re-parses the saved document into a fresh array on every server update,
		// and applying that would clobber whatever the user changed since.
		const w = await mountBuilder([text('b-1', '<p>Loaded copy</p>')]);

		// Stand in for canvas editing — anything the user does emits, which is what
		// arms the echo guard.
		(w.vm as unknown as { loadState: (s: unknown) => void }).loadState({
			blocks: [text('b-1', '<p>Unsaved edit</p>')],
			name: 'Name',
			subject: 'Subject',
		});
		await flushPromises();

		await w.setProps({ blocks: [text('b-1', '<p>Server echo</p>')] });
		await flushPromises();

		expect(w.text()).toContain('Unsaved edit');
		expect(w.text()).not.toContain('Server echo');
	});
});
