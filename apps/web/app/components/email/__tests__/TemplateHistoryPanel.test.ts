/**
 * TemplateHistoryPanel — restoring a snapshot from the preview.
 *
 * The preview and the confirmation dialog share the modal layer. Opening the
 * confirmation over an open preview would stack two backdrops and two focus
 * traps, so the preview has to close as the confirmation opens — that ordering
 * is what these tests pin. Comparing a snapshot with the editor is read-only:
 * it reads the canvas at the moment it is asked, never restores, and drops a
 * snapshot that arrives for a comparison already left.
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

const compareModalStub = {
	props: ['open', 'before', 'after', 'loading'],
	emits: ['update:open'],
	template: `<div v-if="open" data-testid="compare-modal">
		<span data-testid="compare-before">{{ before?.subject ?? '' }}</span>
		<span data-testid="compare-after">{{ after?.subject ?? '' }}</span>
		<button data-testid="compare-close" @click="$emit('update:open', false)">close</button>
		<slot name="actions" />
	</div>`,
};

function mountPanel(
	hasUnsavedChanges: boolean,
	readCurrent?: () => { blocks: never[]; name: string; subject: string },
	autosaves = false
) {
	return mount(TemplateHistoryPanel, {
		props: {
			templateId: 'template1' as never,
			hasUnsavedChanges,
			autosaves,
			...(readCurrent ? { readCurrent } : {}),
		},
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
				EmailTemplateCompareModal: compareModalStub,
				UiIconBox: true,
				UiSpinner: true,
			},
		},
	});
}

/** Open the panel, then the preview for its single version. */
async function openPreview(wrapper: ReturnType<typeof mountPanel>) {
	await wrapper.get('button').trigger('click');
	await flushPromises();
	const preview = document.querySelector<HTMLElement>('[aria-label="Preview this version"]');
	preview?.click();
	await flushPromises();
}

function restoreButton(wrapper: ReturnType<typeof mountPanel>) {
	return wrapper.findAll('button').find((button) => button.text().includes('Restore this version'));
}

beforeEach(() => {
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

	it('restores what the preview loaded after an autosave replaced its row', async () => {
		const query = vi.fn(async () => SNAPSHOT);
		vi.stubGlobal('useConvex', () => ({ query }));
		for (const unsaved of [false, true]) {
			query.mockClear();
			const wrapper = mountPanel(unsaved);
			await openPreview(wrapper);
			// The row is gone now: asking for it again fails.
			query.mockRejectedValue(new Error('Version not found'));

			await restoreButton(wrapper)?.trigger('click');
			await flushPromises();
			if (unsaved) {
				await wrapper.get('[data-testid="confirm"]').trigger('click');
				await flushPromises();
			}

			expect(wrapper.emitted('restore')).toHaveLength(1);
			expect(query).toHaveBeenCalledOnce();
			wrapper.unmount();
			query.mockResolvedValue(SNAPSHOT);
		}
	});

	it('asks for Save after a restore only where the editor does not save by itself', async () => {
		for (const [autosaves, key] of [
			[false, 'components.email.templateHistoryPanel.restored'],
			[true, 'components.email.templateHistoryPanel.restoredAutosave'],
		] as const) {
			const showToast = vi.fn();
			vi.stubGlobal('useToast', () => ({ showToast }));
			const wrapper = mountPanel(false, undefined, autosaves);
			await openPreview(wrapper);
			await restoreButton(wrapper)?.trigger('click');
			await flushPromises();
			expect(showToast).toHaveBeenCalledWith(createTestI18n().global.t(key));
			wrapper.unmount();
		}
	});
});

describe('TemplateHistoryPanel — compare with the editor', () => {
	const unsaved = () => ({
		blocks: [] as never[],
		name: 'Spring launch',
		subject: 'Unsaved subject',
	});

	async function openPanel(wrapper: ReturnType<typeof mountPanel>) {
		await wrapper.get('button').trigger('click');
		await flushPromises();
	}

	function compareButtons() {
		return [
			...document.querySelectorAll<HTMLElement>('[aria-label="Compare with the current editor"]'),
		];
	}

	it('compares the snapshot with the unsaved canvas, read at the click, and restores nothing', async () => {
		const readCurrent = vi.fn(unsaved);
		const wrapper = mountPanel(true, readCurrent);
		await openPanel(wrapper);
		expect(readCurrent).not.toHaveBeenCalled();

		compareButtons()[0]?.click();
		await flushPromises();

		expect(readCurrent).toHaveBeenCalledTimes(1);
		expect(wrapper.get('[data-testid="compare-before"]').text()).toBe('Spring is here');
		expect(wrapper.get('[data-testid="compare-after"]').text()).toBe('Unsaved subject');
		expect(wrapper.emitted('restore')).toBeUndefined();
		wrapper.unmount();
	});

	it('restores from the comparison through the same unsaved-changes question', async () => {
		const wrapper = mountPanel(true, unsaved);
		await openPanel(wrapper);
		compareButtons()[0]?.click();
		await flushPromises();

		await restoreButton(wrapper)?.trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="compare-modal"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(true);
		await wrapper.get('[data-testid="confirm"]').trigger('click');
		await flushPromises();
		expect(wrapper.emitted('restore')).toHaveLength(1);
		wrapper.unmount();
	});

	it('drops a snapshot that arrives after a newer comparison was asked for', async () => {
		const OLDER = { ...VERSION, _id: 'version2', subject: 'Older subject' };
		vi.stubGlobal('useConvexQuery', () => ({
			data: ref([VERSION, OLDER]),
			isLoading: ref(false),
			isRefetching: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		}));
		const pending = new Map<string, (snapshot: typeof SNAPSHOT) => void>();
		vi.stubGlobal('useConvex', () => ({
			query: vi.fn(
				(_ref: unknown, args: { versionId: string }) =>
					new Promise((resolve) => pending.set(args.versionId, resolve))
			),
		}));
		const wrapper = mountPanel(false, unsaved);
		await openPanel(wrapper);

		compareButtons()[0]?.click();
		compareButtons()[1]?.click();
		await flushPromises();
		pending.get('version2')?.({ ...SNAPSHOT, subject: 'Older subject' });
		await flushPromises();
		pending.get('version1')?.(SNAPSHOT);
		await flushPromises();

		expect(wrapper.get('[data-testid="compare-before"]').text()).toBe('Older subject');
		wrapper.unmount();
	});

	it('drops a snapshot that arrives after the comparison was closed', async () => {
		let resolveSnapshot: (snapshot: typeof SNAPSHOT) => void = () => {};
		vi.stubGlobal('useConvex', () => ({
			query: vi.fn(() => new Promise((resolve) => (resolveSnapshot = resolve))),
		}));
		const wrapper = mountPanel(false, unsaved);
		await openPanel(wrapper);
		compareButtons()[0]?.click();
		await flushPromises();

		await wrapper.get('[data-testid="compare-close"]').trigger('click');
		resolveSnapshot(SNAPSHOT);
		await flushPromises();

		expect(wrapper.find('[data-testid="compare-modal"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('offers no comparison without a current editor state', async () => {
		const wrapper = mountPanel(false);
		await openPanel(wrapper);
		expect(compareButtons()).toEqual([]);
		wrapper.unmount();
	});
});
