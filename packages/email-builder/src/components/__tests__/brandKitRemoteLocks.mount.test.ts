// @vitest-environment happy-dom
//
// Co-editing: "Apply brand kit" restyles the whole email, but a block someone
// else holds is theirs until they let go. The restyle leaves it (and every
// Block inside it) as it is, and the confirmation says so.
import { describe, it, expect, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { DEFAULT_BRAND_KIT_DESIGN } from '@owlat/shared/brandKit';
import { childBlockLists } from '@owlat/shared/blockTree';
import EmailBuilder from '../EmailBuilder.vue';
import { EmailBuilderHandlersKey } from '../../composables/useEmailBuilderHandlers';
import { createBlock } from '../../utils/blocks';
import { defaultTheme } from '../../defaults';
import type {
	ContainerBlockContent,
	EditorBlock,
	EmailBuilderBrand,
	RemoteBlockMark,
	TextBlockContent,
} from '../../types';

const brand: EmailBuilderBrand = {
	design: { ...DEFAULT_BRAND_KIT_DESIGN, isConfigured: true, textColor: '#123456' },
	logos: { light: null, dark: null },
};

function text(id: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).textColor = '#333333';
	return block;
}

function container(id: string, children: EditorBlock[]): EditorBlock {
	const block = createBlock('container', defaultTheme);
	block.id = id;
	(block.content as ContainerBlockContent).items = children as ContainerBlockContent['items'];
	return block;
}

const locked: RemoteBlockMark = { label: 'Alex is editing', color: '#2563eb', isLocked: true };

let wrapper: VueWrapper | null = null;

async function mountBuilder(blocks: EditorBlock[], remoteMarks: Record<string, RemoteBlockMark>) {
	wrapper = mount(EmailBuilder, {
		props: {
			blocks,
			subject: 'Subject',
			name: 'Name',
			variables: [],
			remoteMarks,
			config: { brand },
		},
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

function applyDialog(w: VueWrapper) {
	const dialog = w
		.findAllComponents({ name: 'ConfirmationDialog' })
		.find((c) => c.props('title') === 'Apply brand kit?');
	if (!dialog) throw new Error('apply brand kit dialog not rendered');
	return dialog;
}

async function applyBrandKit(w: VueWrapper) {
	await w.find('[data-testid="apply-brand-kit"]').trigger('click');
	await flushPromises();
	applyDialog(w).vm.$emit('confirm');
	await flushPromises();
}

const colorOf = (blocks: EditorBlock[], id: string): string | undefined => {
	for (const block of blocks) {
		if (block.id === id) return (block.content as TextBlockContent).textColor;
		for (const list of childBlockLists(block)) {
			const found = colorOf(list, id);
			if (found) return found;
		}
	}
	return undefined;
};

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('EmailBuilder apply brand kit with remote locks', () => {
	it('leaves a block someone else holds unchanged', async () => {
		const w = await mountBuilder([text('text1'), text('text2')], { text1: locked });
		await applyBrandKit(w);

		const emitted = w.emitted('update:blocks')?.at(-1)?.[0] as EditorBlock[];
		expect(colorOf(emitted, 'text1')).toBe('#333333');
		expect(colorOf(emitted, 'text2')).toBe('#123456');
	});

	it('leaves the Blocks inside a held root unchanged', async () => {
		const w = await mountBuilder([container('box', [text('inner')]), text('free')], {
			box: locked,
		});
		await applyBrandKit(w);

		const emitted = w.emitted('update:blocks')?.at(-1)?.[0] as EditorBlock[];
		expect(colorOf(emitted, 'inner')).toBe('#333333');
		expect(colorOf(emitted, 'free')).toBe('#123456');
	});

	it('emits nothing when every block is held', async () => {
		const w = await mountBuilder([text('text1')], { text1: locked });
		const before = w.emitted('update:blocks')?.length ?? 0;
		await applyBrandKit(w);
		expect(w.emitted('update:blocks')?.length ?? 0).toBe(before);
	});

	it('says in the confirmation which blocks stay unchanged', async () => {
		const w = await mountBuilder([text('text1'), text('text2')], {});
		await w.find('[data-testid="apply-brand-kit"]').trigger('click');
		await flushPromises();
		expect(applyDialog(w).props('description')).not.toContain('lock');

		await w.setProps({ remoteMarks: { text1: locked } });
		await flushPromises();
		expect(applyDialog(w).props('description')).toContain(
			'The block someone else is editing, marked with a lock, stays unchanged'
		);
	});
});
