// @vitest-environment happy-dom
/**
 * TemplateHistoryPanel — restoring a snapshot from the preview.
 *
 * The preview modal deliberately renders above the email builder's own popovers
 * (z 10001), while the confirmation dialog only reaches the shared modal layer.
 * Opening the confirmation UNDER an open preview therefore reads as a dead
 * button, so the preview has to close as the confirmation opens — that ordering
 * is what these tests pin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

// The builder package pulls the whole renderer graph in behind it, which this
// suite has no use for — the snapshot seam is covered by its own unit tests
// (packages/email-builder/src/utils/__tests__/versionSnapshot.test.ts).
vi.mock('@owlat/email-builder', () => ({
	deserializeVersionSnapshot: (snapshot: { name: string; subject: string }) => ({
		blocks: [],
		name: snapshot.name,
		subject: snapshot.subject,
	}),
	formatSnapshotSize: (bytes: number) => `${bytes} B`,
}));

import TemplateHistoryPanel from '../TemplateHistoryPanel.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const VERSION = {
	_id: 'version1',
	trigger: 'save' as const,
	createdAt: 1_700_000_000_000,
	name: 'Spring launch',
	subject: 'Spring is here',
	contentBytes: 512,
};

const SNAPSHOT = { content: '[]', name: 'Spring launch', subject: 'Spring is here' };

const modalStub = {
	props: ['open', 'size', 'zIndex'],
	emits: ['update:open'],
	template: `<div v-if="open" data-testid="preview-modal"><slot /></div>`,
};

const confirmationDialogStub = {
	props: ['open', 'title', 'description', 'confirmText', 'variant', 'isLoading'],
	emits: ['update:open', 'confirm', 'cancel'],
	template: `<div v-if="open" data-testid="confirm-dialog">
		<button data-testid="confirm" @click="$emit('confirm')">{{ confirmText }}</button>
	</div>`,
};

function mountPanel(hasUnsavedChanges: boolean) {
	return mount(TemplateHistoryPanel, {
		props: { templateId: 'template1' as never, hasUnsavedChanges },
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			// Auto-imported utils are read off the render context in templates, so a
			// global stub alone does not reach them.
			mocks: { formatRelativeTime: () => '2 days ago' },
			stubs: {
				UiModal: modalStub,
				UiModalFooter: { template: '<div><slot /></div>' },
				UiConfirmationDialog: confirmationDialogStub,
				UiIconBox: true,
				UiSpinner: true,
				Icon: true,
			},
		},
	});
}

/** Open the panel, then the preview for its single version. */
async function openPreview(wrapper: ReturnType<typeof mountPanel>) {
	await wrapper.get('button').trigger('click');
	await flushPromises();
	const preview = document.querySelector<HTMLElement>('[title="Preview this version"]');
	preview?.click();
	await flushPromises();
}

function restoreButton(wrapper: ReturnType<typeof mountPanel>) {
	return wrapper.findAll('button').find((button) => button.text().includes('Restore this version'));
}

beforeEach(() => {
	document.body.innerHTML = '';
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useConvexQuery', () => ({
		data: ref([VERSION]),
		isLoading: ref(false),
		isRefetching: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useConvex', () => ({ query: vi.fn(async () => SNAPSHOT) }));
	vi.stubGlobal('useEmailTheme', () => ({ emailTheme: ref({}) }));
	vi.stubGlobal('useEmailHtmlRendering', () => ({ renderBlocksToHtml: () => '<p>hi</p>' }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useClickOutside', vi.fn());
	vi.stubGlobal('formatRelativeTime', () => '2 days ago');
});

describe('TemplateHistoryPanel — restore from the preview', () => {
	it('closes the preview as it asks about unsaved changes, so the question is visible', async () => {
		const wrapper = mountPanel(true);
		await openPreview(wrapper);
		expect(wrapper.find('[data-testid="preview-modal"]').exists()).toBe(true);

		await restoreButton(wrapper)?.trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="preview-modal"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true);
		expect(wrapper.emitted('restore')).toBeUndefined();

		await wrapper.get('[data-testid="confirm"]').trigger('click');
		await flushPromises();
		expect(wrapper.emitted('restore')).toHaveLength(1);
		wrapper.unmount();
	});

	it('restores straight from the preview when there is nothing to lose', async () => {
		const wrapper = mountPanel(false);
		await openPreview(wrapper);

		await restoreButton(wrapper)?.trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false);
		expect(wrapper.emitted('restore')).toHaveLength(1);
		wrapper.unmount();
	});
});
