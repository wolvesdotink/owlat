// @vitest-environment happy-dom
//
// Co-editing: another person's edits arrive while this editor is open. They
// must land on the canvas without taking the selection away, and undo here
// must keep stepping through this editor's own edits only. A block someone
// else holds is outlined with their name and cannot be selected.
import { describe, it, expect, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { CoeditOp } from '@owlat/shared/coeditOps';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import type { EditorBlock, RemoteBlockMark, TextBlockContent } from '../../types';

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

interface BuilderApi {
	applyRemoteOps: (ops: CoeditOp<EditorBlock>[]) => void;
}

let wrapper: VueWrapper | null = null;

async function mountBuilder(blocks: EditorBlock[], remoteMarks?: Record<string, RemoteBlockMark>) {
	wrapper = mount(EmailBuilder, {
		props: { blocks, subject: 'Subject', name: 'Name', variables: [], remoteMarks },
		global: {
			provide: {
				[EmailBuilderHandlersKey as symbol]: {
					uploadImage: async () => ({ url: '', storageId: '' }),
				},
			},
			stubs: { PreviewPanel: true, FloatingBlockSidebar: true },
		},
	});
	await flushPromises();
	return wrapper;
}

const api = (w: VueWrapper) => w.vm as unknown as BuilderApi;
const blockEl = (w: VueWrapper, id: string) => w.find(`[data-block-id="${id}"]`);

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder applyRemoteOps', () => {
	it("applies another person's edits and keeps the selection", async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>'), text('b', '<p>Beta</p>')]);
		await blockEl(w, 'a').trigger('click');
		expect(blockEl(w, 'a').attributes('aria-current')).toBe('true');

		api(w).applyRemoteOps([
			{ kind: 'update', block: text('b', '<p>Beta edited</p>'), afterId: 'a' },
			{ kind: 'insert', block: text('c', '<p>Gamma</p>'), afterId: 'b' },
			{ kind: 'field', field: 'subject', value: 'Their subject' },
		]);
		await flushPromises();

		expect(w.text()).toContain('Beta edited');
		expect(w.text()).toContain('Gamma');
		expect(blockEl(w, 'a').attributes('aria-current')).toBe('true');
		expect(w.emitted('update:subject')?.at(-1)).toEqual(['Their subject']);
	});

	it('clears the selection when the selected block is deleted remotely', async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>'), text('b', '<p>Beta</p>')]);
		await blockEl(w, 'a').trigger('click');

		api(w).applyRemoteOps([{ kind: 'delete', blockId: 'a' }]);
		await flushPromises();

		expect(blockEl(w, 'a').exists()).toBe(false);
		const focus = w.emitted('collab-focus')?.at(-1)?.[0] as { selectedRootId: string | null };
		expect(focus.selectedRootId).toBeNull();
	});

	it('does not copy the incoming blocks by reference into the canvas', async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>')]);
		const incoming = text('a', '<p>Remote</p>');
		api(w).applyRemoteOps([{ kind: 'update', block: incoming, afterId: null }]);
		await flushPromises();
		const emitted = w.emitted('update:blocks')?.at(-1)?.[0] as EditorBlock[];
		expect(emitted[0]).not.toBe(incoming);
		expect((emitted[0]!.content as TextBlockContent).html).toBe('<p>Remote</p>');
	});

	it('reports the selected root for presence', async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>')]);
		await blockEl(w, 'a').trigger('click');
		const focus = w.emitted('collab-focus')?.at(-1)?.[0];
		expect(focus).toEqual({ selectedRootId: 'a', inlineEditRootId: null });
	});
});

describe('EmailBuilder remote marks', () => {
	const mark = (isLocked: boolean): RemoteBlockMark => ({
		label: isLocked ? 'Alex is editing' : 'Alex',
		color: '#2563eb',
		isLocked,
	});

	it("outlines a block with the other person's name", async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>')], { a: mark(false) });
		expect(blockEl(w, 'a').find('[data-testid="remote-block-label"]').text()).toBe('Alex');
	});

	it('refuses to select a block someone else holds', async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>'), text('b', '<p>Beta</p>')], {
			a: mark(true),
		});
		await blockEl(w, 'a').trigger('click');
		expect(blockEl(w, 'a').attributes('aria-current')).toBeUndefined();
		expect(blockEl(w, 'a').text()).toContain('Alex is editing');
	});

	it('lets go of a selected block once someone else takes it', async () => {
		const w = await mountBuilder([text('a', '<p>Alpha</p>')], {});
		await blockEl(w, 'a').trigger('click');
		expect(blockEl(w, 'a').attributes('aria-current')).toBe('true');

		await w.setProps({ remoteMarks: { a: mark(true) } });
		await flushPromises();
		expect(blockEl(w, 'a').attributes('aria-current')).toBeUndefined();
	});
});
