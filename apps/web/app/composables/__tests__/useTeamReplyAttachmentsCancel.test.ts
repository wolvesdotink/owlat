import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';
import type * as Uploads from '~/composables/postbox/postboxAttachmentUploads';

/**
 * #1273 in the Team inbox reply composer: cancelling an upload while
 * `replyAttachments.add` runs. The add commits after the cancel, so the
 * composer takes that entry back off the thread (by its id) and holds Send
 * until it has.
 */

const i18n = createTestI18n();

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		inbox: {
			replyAttachments: {
				list: 'replyAttachments.list',
				suggestions: 'replyAttachments.suggestions',
				add: 'replyAttachments.add',
				attachExisting: 'replyAttachments.attachExisting',
				remove: 'replyAttachments.remove',
			},
		},
	},
}));

vi.mock('~/composables/postbox/postboxAttachmentUploads', async (importActual) => ({
	...(await importActual<typeof Uploads>()),
	xhrPutFile: vi.fn(async () => 'storage_salary'),
}));

interface Entry {
	index: number;
	id: string;
	filename: string;
	size: number;
	status: 'ready';
}

/** The thread's reply attachments as the server holds them (the subscription). */
const serverList = ref<Entry[]>([]);
let releaseAdd: () => void;
let removeOp: ReturnType<typeof vi.fn>;

const view = (entries: Omit<Entry, 'index'>[]): Entry[] =>
	entries.map((entry, index) => ({ ...entry, index }));

beforeEach(() => {
	// A teammate's file is already on the thread.
	serverList.value = view([{ id: 'e_theirs', filename: 'terms.pdf', size: 10, status: 'ready' }]);
	removeOp = vi.fn(async (args: { index: number; id?: string }) => {
		serverList.value = view(serverList.value.filter((entry) => entry.id !== args.id));
		return { ok: true, result: serverList.value };
	});
	const ops: Record<string, (args: never) => Promise<unknown>> = {
		'storage.generateUploadUrl': async () => ({ ok: true, result: 'https://upload.example' }),
		'replyAttachments.add': (args: { filename: string }) =>
			new Promise((resolve) => {
				releaseAdd = () => {
					serverList.value = view([
						...serverList.value,
						{ id: 'e_salary', filename: args.filename, size: 1, status: 'ready' },
					]);
					resolve({ ok: true, result: serverList.value });
				};
			}),
		'replyAttachments.remove': removeOp as never,
	};
	vi.stubGlobal('useBackendOperation', (name: string) => ({
		run: ops[name] ?? vi.fn(async () => ({ ok: false })),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useConvexQuery', (name: string) => ({
		data: name === 'replyAttachments.list' ? serverList : ref(null),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useI18n', () => i18n.global);
});

const flush = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

describe('useTeamReplyAttachments: cancel while the file attaches', () => {
	it('leaves no chip and no attachment on the thread, and holds Send until then', async () => {
		const { useTeamReplyAttachments } = await import('../useTeamReplyAttachments');
		const files = withSetup(() => useTeamReplyAttachments(() => 'th_1' as never)).result;

		files.addFiles([new File(['x'], 'salary.xlsx', { type: 'application/vnd.ms-excel' })]);
		await flush();
		expect(files.uploads.value).toHaveLength(1);

		files.cancelUpload(files.uploads.value[0]!.id);
		expect(files.uploads.value).toHaveLength(0);
		expect(files.block.value).toBe('uploading');

		// The add was already on its way and commits after the cancel.
		releaseAdd();
		await flush();

		expect(removeOp).toHaveBeenCalledWith({ threadId: 'th_1', index: 1, id: 'e_salary' });
		expect(serverList.value.map((entry) => entry.filename)).toEqual(['terms.pdf']);
		expect(files.attachments.value.map((entry) => entry.filename)).toEqual(['terms.pdf']);
		expect(files.uploads.value).toEqual([]);
		expect(files.block.value).toBeNull();
	});
});
