/**
 * The Email editor bridge driving a MOUNTED EmailBuilder.
 *
 * The builder keeps its own copy of the blocks (the canvas) and ignores an
 * incoming `blocks` prop that carries the ids it last emitted, so a stale echo
 * cannot clobber in-flight edits. The dirty tracker decides when the page's
 * refs follow the server; these tests pin that the canvas follows with them.
 * Asserting on the page refs alone passed while the canvas showed the old copy,
 * and the next edit saved that old copy under the new revision.
 *
 * Also pinned here: the toolbar Save button. Its handler's rejection reached
 * Vue's error handling and swapped the editor for the page's error boundary.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mediaAssets: { create: 'mediaAssets.create' },
		emailBlocks: { blocks: { create: 'emailBlocks.blocks.create' } },
	},
}));

import { defineComponent, h, nextTick, onErrorCaptured, ref, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import {
	EmailBuilder,
	createBlock,
	defaultTheme,
	type EditorBlock,
	type TextBlockContent,
} from '@owlat/email-builder';
import { useEmailEditorBridge, type EmailEditorBridgeReturn } from '../useEmailEditorBridge';
import { StaleDraftError } from '../useEditorSaveOperation';
import { SurfacedOperationError } from '~/lib/operationError';

interface Row {
	_id: string;
	name: string;
	subject: string;
	content: string;
	contentRevision: number;
}

function text(id: string, html: string): EditorBlock {
	const block = createBlock('text', defaultTheme);
	block.id = id;
	(block.content as TextBlockContent).html = html;
	return block;
}

function row(contentRevision: number, blocks: EditorBlock[]): Row {
	return {
		_id: 't1',
		name: 'Launch',
		subject: 'Hello',
		content: JSON.stringify(blocks),
		contentRevision,
	};
}

type SurfaceSave = (blocks: EditorBlock[], revision: number | undefined) => Promise<number | void>;

const showToast = vi.fn();

let wrapper: VueWrapper | null = null;

function mountEditor(source: Ref<Row | null>, surfaceSave: SurfaceSave) {
	let bridge!: EmailEditorBridgeReturn;
	const boundaryError = ref<unknown>(null);

	// Stands in for the page's UiErrorBoundary: whatever reaches Vue's error
	// handling from inside the builder replaces it.
	const Boundary = defineComponent({
		setup(_, { slots }) {
			onErrorCaptured((error) => {
				boundaryError.value = error;
				return false;
			});
			return () =>
				boundaryError.value
					? h('p', 'The email editor hit an unexpected error')
					: slots.default?.();
		},
	});

	const Host = defineComponent({
		setup() {
			bridge = useEmailEditorBridge<Row | null>({
				source,
				revision: (r) => r.contentRevision,
				initialize: (r, ctx) => {
					ctx.name.value = r.name;
					ctx.subject.value = r.subject;
					ctx.blocks.value = JSON.parse(r.content) as EditorBlock[];
				},
				save: (ctx, base) =>
					surfaceSave(JSON.parse(JSON.stringify(ctx.blocks.value)) as EditorBlock[], base.revision),
			});
			return () =>
				h(Boundary, null, () =>
					h(EmailBuilder, {
						ref: bridge.builderRef,
						blocks: bridge.blocks.value,
						'onUpdate:blocks': (v: EditorBlock[]) => (bridge.blocks.value = v),
						subject: bridge.subject.value,
						'onUpdate:subject': (v: string) => (bridge.subject.value = v),
						name: bridge.name.value,
						'onUpdate:name': (v: string) => (bridge.name.value = v),
						variables: [],
						onSave: bridge.requestSave,
					})
				);
		},
	});

	wrapper = mount(Host, {
		// The builder's dialogs are closed throughout; the UI layer's modal is a
		// Nuxt-registered component the builder resolves by name.
		global: { stubs: { PreviewPanel: true, FloatingBlockSidebar: true, UiModal: true } },
	});
	return { bridge: () => bridge, boundaryError };
}

const builder = () => wrapper!.findComponent(EmailBuilder);
const canvasEdit = (blocks: EditorBlock[]) =>
	(builder().vm as unknown as { loadState: (s: unknown) => void }).loadState({
		blocks,
		name: 'Launch',
		subject: 'Hello',
	});
// The header's own Save button, as the user clicks it.
const saveButton = () => wrapper!.findAll('button').find((b) => b.text() === 'Save')!;
const htmlOf = (blocks: EditorBlock[]) =>
	blocks.map((b) => (b.content as TextBlockContent).html).join(' ');

// Nuxt auto-imports, replaced per test. Not unstubbed afterwards: that would
// also drop the setup file's Vue globals (`onMounted`, …) the bridge reads.
beforeEach(() => {
	showToast.mockReset();
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en'), te: () => true }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: vi.fn(),
	}));
	vi.stubGlobal('useKeyboardShortcuts', () => ({
		registerSaveShortcut: vi.fn(),
		unregisterShortcut: vi.fn(),
	}));
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('canvas follows a hydration the tracker accepts', () => {
	it('shows a collaborator write on the canvas while clean, and saves on top of it', async () => {
		const source = ref<Row | null>(
			row(0, [text('b-1', '<p>Loaded</p>'), text('b-2', '<p>Mine</p>')])
		);
		const saved: { blocks: EditorBlock[]; revision: number | undefined }[] = [];
		const { bridge } = mountEditor(source, async (blocks, revision) => {
			saved.push({ blocks, revision });
			return (revision ?? 0) + 1;
		});
		await flushPromises();
		expect(builder().text()).toContain('Loaded');

		// The user edits b-2 and saves; the echo lands and the editor is clean.
		// (Any canvas edit arms the builder's same-ids echo guard.)
		canvasEdit([text('b-1', '<p>Loaded</p>'), text('b-2', '<p>Mine v2</p>')]);
		await flushPromises();
		await bridge().requestSave();
		source.value = row(1, [text('b-1', '<p>Loaded</p>'), text('b-2', '<p>Mine v2</p>')]);
		await flushPromises();
		expect(bridge().hasChanges.value).toBe(false);

		// A collaborator rewrites b-1 (same ids) while this editor holds nothing.
		source.value = row(2, [text('b-1', '<p>Collaborator</p>'), text('b-2', '<p>Mine v2</p>')]);
		await flushPromises();

		expect(bridge().hasChanges.value).toBe(false);
		expect(builder().text()).toContain('Collaborator');
		expect(builder().text()).not.toContain('Loaded');

		// The user edits b-2 again: the payload keeps the collaborator's b-1 and
		// names the revision it was built on.
		canvasEdit([text('b-1', '<p>Collaborator</p>'), text('b-2', '<p>Mine v3</p>')]);
		await flushPromises();
		expect(bridge().hasChanges.value).toBe(true);
		await bridge().requestSave();

		expect(saved.map((s) => s.revision)).toEqual([0, 2]);
		expect(htmlOf(saved[1]!.blocks)).toBe('<p>Collaborator</p> <p>Mine v3</p>');
	});

	it('leaves the canvas alone when the echo of its own save arrives', async () => {
		const source = ref<Row | null>(row(3, [text('b-1', '<p>Loaded</p>')]));
		const { bridge } = mountEditor(source, async (_blocks, revision) => (revision ?? 0) + 1);
		await flushPromises();

		canvasEdit([text('b-1', '<p>Edited</p>')]);
		await flushPromises();
		await bridge().requestSave();
		const emitted = builder().emitted('update:blocks')!.length;

		source.value = row(4, [text('b-1', '<p>Edited</p>')]);
		await flushPromises();

		expect(bridge().hasChanges.value).toBe(false);
		expect(builder().text()).toContain('Edited');
		// Same content: no re-seed, so no new emission (and no undo step).
		expect(builder().emitted('update:blocks')!.length).toBe(emitted);
	});

	it('keeps unsaved canvas edits over a collaborator write', async () => {
		const source = ref<Row | null>(row(0, [text('b-1', '<p>Loaded</p>')]));
		const { bridge } = mountEditor(source, async () => 1);
		await flushPromises();

		canvasEdit([text('b-1', '<p>Unsaved edit</p>')]);
		await flushPromises();
		source.value = row(1, [text('b-1', '<p>Collaborator</p>')]);
		await flushPromises();

		expect(bridge().hasChanges.value).toBe(true);
		expect(builder().text()).toContain('Unsaved edit');
		expect(builder().text()).not.toContain('Collaborator');
	});

	it('does not put a row older than the acknowledged write back on the canvas', async () => {
		// A send-counter bump at the old revision arrives while the save is in
		// flight; acknowledging the save must not hydrate it over the new copy.
		const source = ref<Row | null>(row(2, [text('b-1', '<p>Loaded</p>')]));
		let land!: (revision: number) => void;
		const { bridge } = mountEditor(
			source,
			() => new Promise<number>((resolve) => (land = resolve))
		);
		await flushPromises();

		canvasEdit([text('b-1', '<p>Saved copy</p>')]);
		await flushPromises();
		const pending = bridge().requestSave();
		source.value = { ...row(2, [text('b-1', '<p>Loaded</p>')]), name: 'Launch' };
		await flushPromises();
		land(3);
		await pending;
		await flushPromises();

		expect(bridge().hasChanges.value).toBe(false);
		expect(builder().text()).toContain('Saved copy');
		expect(htmlOf(bridge().blocks.value)).toBe('<p>Saved copy</p>');
	});
});

describe('the toolbar Save button', () => {
	it('keeps the editor and the draft when the save fails', async () => {
		const source = ref<Row | null>(row(0, [text('b-1', '<p>Loaded</p>')]));
		const { bridge, boundaryError } = mountEditor(source, () =>
			Promise.reject(new SurfacedOperationError('Save failed'))
		);
		await flushPromises();
		canvasEdit([text('b-1', '<p>Draft</p>')]);
		await flushPromises();

		await saveButton().trigger('click');
		await flushPromises();

		expect(boundaryError.value).toBeNull();
		expect(builder().exists()).toBe(true);
		expect(builder().text()).toContain('Draft');
		expect(bridge().hasChanges.value).toBe(true);
		// Already toasted by the operation module; not toasted twice.
		expect(showToast).not.toHaveBeenCalled();
	});

	it('toasts a failure nothing has shown yet instead of throwing', async () => {
		const source = ref<Row | null>(row(0, [text('b-1', '<p>Loaded</p>')]));
		const { boundaryError } = mountEditor(source, () =>
			Promise.reject(new Error('renderer exploded'))
		);
		await flushPromises();
		canvasEdit([text('b-1', '<p>Draft</p>')]);
		await flushPromises();

		await saveButton().trigger('click');
		await flushPromises();

		expect(boundaryError.value).toBeNull();
		expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
	});
});

describe('stale-revision conflict', () => {
	it('keeps my version: saves the same draft on the latest revision', async () => {
		const source = ref<Row | null>(row(0, [text('b-1', '<p>Loaded</p>')]));
		const revisions: (number | undefined)[] = [];
		const { bridge } = mountEditor(source, async (_blocks, revision) => {
			revisions.push(revision);
			if (revision === 0) throw new StaleDraftError(1);
			return (revision ?? 0) + 1;
		});
		await flushPromises();
		canvasEdit([text('b-1', '<p>Mine</p>')]);
		await flushPromises();

		await bridge().requestSave();
		expect(bridge().conflict.value).toEqual({ currentRevision: 1 });
		expect(bridge().hasChanges.value).toBe(true);

		// The collaborator's row reaches this tab after the refusal.
		const keeping = bridge().keepMyVersion();
		source.value = row(1, [text('b-1', '<p>Theirs</p>')]);
		await keeping;
		await flushPromises();

		expect(revisions).toEqual([0, 1]);
		expect(bridge().conflict.value).toBeNull();
		expect(bridge().hasChanges.value).toBe(false);
		expect(builder().text()).toContain('Mine');
	});

	it('loads the latest: discards the draft and shows the server version', async () => {
		const source = ref<Row | null>(row(0, [text('b-1', '<p>Loaded</p>')]));
		const { bridge } = mountEditor(source, async () => {
			throw new StaleDraftError(1);
		});
		await flushPromises();
		canvasEdit([text('b-1', '<p>Mine</p>')]);
		await flushPromises();
		source.value = row(1, [text('b-1', '<p>Theirs</p>')]);
		await flushPromises();
		expect(builder().text()).toContain('Mine');

		await bridge().requestSave();
		await bridge().loadLatestVersion();
		await flushPromises();
		await nextTick();

		expect(bridge().conflict.value).toBeNull();
		expect(bridge().hasChanges.value).toBe(false);
		expect(builder().text()).toContain('Theirs');
		expect(builder().text()).not.toContain('Mine');
	});
});

describe('the email editor pages', () => {
	// The pages are too heavy to mount here; pin the wiring the tests above
	// exercise. `@save="save"` (a rejecting handler) is what swapped the editor
	// for the error boundary.
	const pages = ['emails', 'transactional'].map((kind) => {
		const path = join(dirname(fileURLToPath(import.meta.url)), '../../pages/dashboard/send');
		return [kind, readFileSync(join(path, kind, '[id]', 'edit.vue'), 'utf8')] as const;
	});

	it.each(pages)('%s: Save goes through requestSave, and the canvas is bound', (_kind, source) => {
		const builderTag = /<EmailBuilder\b[^>]*>/s.exec(source)?.[0] ?? '';
		expect(builderTag).toContain('@save="requestSave"');
		expect(builderTag).toContain('ref="builderRef"');
		expect(source).toContain('<EmailEditorConflictDialog');
	});
});
