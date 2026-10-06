// @vitest-environment happy-dom
/**
 * Regression: files picked with the paperclip were never attached in Chrome.
 * The footer emitted the file input's live `FileList` and then reset the
 * input; Chrome empties that same list in place on the reset, and `addFiles`
 * reads it only after awaiting the draft row, so it saw zero files.
 *
 * The input here behaves like Chrome's: `files` is one live list that a value
 * reset clears. The footer's event goes into the real `addFiles`, and the file
 * must reach the uploader whether the draft row is created by the pick or
 * already exists.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { withSetup } from '~/__tests__/withSetup';
import { composerTargetCapabilities } from '~/utils/composerTarget';
import { usePostboxComposeAttachments } from '~/composables/postbox/usePostboxComposeAttachments';
import PostboxComposerFooter from '../PostboxComposerFooter.vue';

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mail: {
			drafts: {
				addAttachment: 'drafts.addAttachment',
				removeAttachment: 'drafts.removeAttachment',
			},
			draftExpectedAttachments: { remove: 'expected.remove' },
			draftExpectedAttachmentsFulfil: { fulfil: 'expected.fulfil' },
			attachmentSharesActions: {
				shareDraftAttachment: 'attachmentSharesActions.shareDraftAttachment',
			},
		},
	},
}));

// What reaches the upload state machine is what the person sees as a chip.
const uploaderAddFiles = vi.fn();
vi.mock('~/composables/postbox/postboxAttachmentUploads', () => ({
	createAttachmentUploads: () => ({
		uploads: ref([]),
		isUploading: ref(false),
		addFiles: uploaderAddFiles,
		cancel: () => {},
		retry: () => {},
		dispose: () => {},
	}),
	xhrPutFile: () => Promise.resolve('sid'),
}));

/** The real catalog behind the `useI18n` auto-import both sides call. */
const i18n = createTestI18n();

const mailboxCapabilities = composerTargetCapabilities({
	kind: 'mailbox',
	mailboxId: 'mbx_1' as never,
});

beforeEach(() => {
	uploaderAddFiles.mockClear();
	vi.stubGlobal('useNativeFilePicker', () => ({
		isDesktop: ref(false),
		pickNativeFiles: vi.fn(),
	}));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useInboxes', () => ({ byId: ref(new Map()) }));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(async () => undefined) }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined) }));
});

function mountFooter(onAddFiles: (files: File[]) => unknown) {
	return mount(PostboxComposerFooter, {
		props: {
			capabilities: mailboxCapabilities,
			canSend: true,
			sending: false,
			isUploading: false,
			isScheduled: false,
			sendShortcutHint: 'Cmd+Enter',
			scheduleShortcutHint: 'Cmd+Shift+Enter',
			showSignaturePicker: false,
			signatures: [],
			activeSignatureId: null,
			composerMode: 'rich',
			persistentToolbar: false,
			lastSavedLabel: 'Saved',
			followUpRemindAt: null,
			subject: '',
			bodyHtml: '',
			bodyBlocks: [],
			onAddFiles,
		},
		global: {
			plugins: [i18n],
			stubs: {
				Icon: true,
				PostboxOverflowMenu: true,
				PostboxComposerPreflightChip: true,
				PostboxPreviewAsSent: true,
				PostboxFollowUpDialog: true,
				PostboxComposerFollowUp: true,
				PostboxComposerModeControls: true,
			},
		},
	});
}

/**
 * Give the input Chrome's behaviour: `files` always returns the same live list,
 * and setting the value to '' empties that list in place.
 */
function pickLikeChrome(input: HTMLInputElement, picked: File[]) {
	const live: File[] = [...picked];
	Object.defineProperty(input, 'files', {
		configurable: true,
		get: () => live,
	});
	Object.defineProperty(input, 'value', {
		configurable: true,
		get: () => (live.length > 0 ? `C:\\fakepath\\${live[0]!.name}` : ''),
		set: (v: string) => {
			if (v === '') live.length = 0;
		},
	});
	input.dispatchEvent(new Event('change'));
	return live;
}

describe('PostboxComposerFooter attach button', () => {
	it('attaches a file picked into a new draft after the input is reset', async () => {
		let createRow!: (id: string) => void;
		const draftId = ref<string | null>(null);
		const composer = withSetup(() =>
			usePostboxComposeAttachments({
				// The pick creates the row, which resolves only after the reset.
				ensureDraft: () =>
					new Promise((resolve) => {
						createRow = (id) => {
							draftId.value = id;
							resolve(id as never);
						};
					}),
				draftId: draftId as never,
			})
		).result;
		const wrapper = mountFooter(composer.addFiles);
		const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
		const report = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });

		const live = pickLikeChrome(input, [report]);
		// The handler reset the input, so the live list is gone.
		expect(live).toHaveLength(0);
		expect(input.value).toBe('');

		createRow('draft-1');
		await flushPromises();
		expect(uploaderAddFiles).toHaveBeenCalledOnce();
		expect(uploaderAddFiles.mock.calls[0]![0]).toEqual([report]);
	});

	it('attaches a file picked into an existing draft after the input is reset', async () => {
		const composer = withSetup(() =>
			usePostboxComposeAttachments({
				ensureDraft: () => Promise.resolve('draft-1' as never),
				draftId: ref('draft-1' as never),
			})
		).result;
		const wrapper = mountFooter(composer.addFiles);
		const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
		const a = new File(['a'], 'a.txt', { type: 'text/plain' });
		const b = new File(['b'], 'b.txt', { type: 'text/plain' });

		pickLikeChrome(input, [a, b]);
		await flushPromises();
		expect(uploaderAddFiles).toHaveBeenCalledOnce();
		expect(uploaderAddFiles.mock.calls[0]![0]).toEqual([a, b]);
	});

	it('emits a copy of the picked files, not the input list', () => {
		const onAddFiles = vi.fn();
		const wrapper = mountFooter(onAddFiles);
		const input = wrapper.get('input[type="file"]').element as HTMLInputElement;
		const a = new File(['a'], 'a.txt', { type: 'text/plain' });

		const live = pickLikeChrome(input, [a]);
		expect(onAddFiles).toHaveBeenCalledOnce();
		const emitted = onAddFiles.mock.calls[0]![0] as File[];
		expect(Array.isArray(emitted)).toBe(true);
		expect(emitted).not.toBe(live);
		expect(emitted).toEqual([a]);
	});

	it('emits nothing when the picker closes without a file', () => {
		const onAddFiles = vi.fn();
		const wrapper = mountFooter(onAddFiles);
		const input = wrapper.get('input[type="file"]').element as HTMLInputElement;

		pickLikeChrome(input, []);
		expect(onAddFiles).not.toHaveBeenCalled();
	});
});
