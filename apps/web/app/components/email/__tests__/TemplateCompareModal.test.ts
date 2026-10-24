/**
 * TemplateCompareModal — two versions side by side, the changed Blocks
 * outlined in each preview, and the list of what changed. The comparison
 * itself is pinned in `packages/email-renderer` (templateDiff.test.ts); here
 * what matters is that each preview is rendered from its own side with its own
 * outlines, and that the list says what changed in words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import TemplateCompareModal from '../TemplateCompareModal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const renders: Array<{ ids: string[]; outlines: Record<string, string> | undefined }> = [];

const modalStub = {
	props: ['open', 'size', 'title'],
	emits: ['update:open'],
	template: `<div v-if="open" data-testid="modal"><h2>{{ title }}</h2><slot /><slot name="footer" /></div>`,
};

const text = (id: string, html: string) => ({ id, type: 'text', content: { html } }) as never;
const button = (id: string, label: string, url: string) =>
	({ id, type: 'button', content: { text: label, url } }) as never;

const BEFORE = {
	label: 'Saved',
	detail: 'Yesterday',
	subject: 'Spring is here',
	blocks: [text('t1', '<p>Hello there</p>'), button('b1', 'Shop', 'https://example.com/a')],
};
const AFTER = {
	label: 'In the editor now',
	subject: 'Spring is finally here',
	blocks: [
		text('t1', '<p>Hello world</p>'),
		button('b1', 'Shop', 'https://example.com/b'),
		text('t2', '<p>New line</p>'),
	],
};

function mountModal(props: Record<string, unknown>) {
	return mount(TemplateCompareModal, {
		props: { open: true, before: BEFORE, after: AFTER, ...props },
		slots: { actions: '<button data-testid="extra-action">Restore</button>' },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiModal: modalStub,
				UiSpinner: true,
				UiBadge: { template: '<span><slot /></span>' },
			},
		},
	});
}

beforeEach(() => {
	renders.length = 0;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useEmailTheme', () => ({ emailTheme: ref({}) }));
	vi.stubGlobal('useEmailHtmlRendering', () => ({
		renderBlocksToHtml: (
			blocks: Array<{ id: string }>,
			options: { diffOutlines?: Record<string, string> }
		) => {
			renders.push({ ids: blocks.map((block) => block.id), outlines: options.diffOutlines });
			return `<p>${blocks.length} blocks</p>`;
		},
	}));
});

describe('TemplateCompareModal', () => {
	it('renders each side with its own outlines', () => {
		const wrapper = mountModal({});

		expect(renders).toEqual([
			{ ids: ['t1', 'b1'], outlines: { t1: 'edited', b1: 'edited' } },
			{ ids: ['t1', 'b1', 't2'], outlines: { t1: 'edited', b1: 'edited', t2: 'added' } },
		]);
		const frames = wrapper.findAll('iframe');
		expect(frames.map((frame) => frame.attributes('sandbox'))).toEqual(['', '']);
		expect(frames.map((frame) => frame.attributes('title'))).toEqual([
			'Email preview: Saved',
			'Email preview: In the editor now',
		]);
	});

	it('lists the subject, Block, copy and link changes in words', () => {
		const text = mountModal({}).text();

		expect(text).toContain('1 block added');
		expect(text).toContain('2 blocks edited');
		expect(text).toContain('Spring is here');
		expect(text).toContain('Spring is finally here');
		expect(text).toContain('Hello there');
		expect(text).toContain('Hello world');
		expect(text).toContain('https://example.com/a');
		expect(text).toContain('https://example.com/b');
		expect(text).toContain('New line');
	});

	it('says so when nothing differs', () => {
		const text = mountModal({ after: { ...BEFORE, label: 'Now' } }).text();
		expect(text).toContain('No differences');
		expect(text).not.toContain('Copy changes');
	});

	it('waits for both sides before comparing', () => {
		const wrapper = mountModal({ before: null, loading: true });
		expect(renders).toEqual([]);
		expect(wrapper.find('[data-testid="template-compare"]').exists()).toBe(false);
	});

	it('renders nothing while closed and keeps the caller actions in the footer', () => {
		expect(mountModal({ open: false }).find('[data-testid="modal"]').exists()).toBe(false);
		expect(renders).toEqual([]);
		expect(mountModal({}).find('[data-testid="extra-action"]').exists()).toBe(true);
	});
});
