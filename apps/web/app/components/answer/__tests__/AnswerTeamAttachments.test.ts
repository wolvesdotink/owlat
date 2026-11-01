/**
 * The files on a Team inbox reply in Answer mode:
 *  - the agent's matched file (`AttachSuggestion`, computed and stored for
 *    every such message) is mounted, and picking
 *    it attaches that Files row;
 *  - a copy still running shows as "Copying…", a failed one says why;
 *  - Attach uploads a file or picks one of the contact's files, this
 *    conversation's first, and hides what is already attached.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AttachSuggestion from '~/components/inbox/AttachSuggestion.vue';
import AnswerTeamAttachments from '../AnswerTeamAttachments.vue';

// Each `api.*` access remembers its path, so the test sees which query is read.
vi.mock('@owlat/api', () => {
	const at = (path: string[]): unknown =>
		new Proxy(function () {}, {
			get: (_target, key) => (key === '__path' ? path.join('.') : at([...path, String(key)])),
			apply: () => at(path),
		});
	return { api: at([]) };
});

const contactFiles = ref<unknown[]>([]);
const queryArgs: unknown[] = [];
const queryPaths: string[] = [];
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useConvexQuery: (query: { __path: string }, args: () => unknown) => {
			queryPaths.push(query.__path);
			queryArgs.push(args);
			return { data: contactFiles, isLoading: ref(false) };
		},
	});
});
beforeEach(() => {
	contactFiles.value = [];
	queryArgs.length = 0;
	queryPaths.length = 0;
});

const ready = {
	index: 0,
	id: 'a1',
	filename: 'invoice-2026-09.pdf',
	contentType: 'application/pdf',
	size: 86016,
	origin: 'semanticFile',
	sourceId: 'sf_1',
	status: 'ready',
	url: 'https://example.com/blob',
	addedBy: 'u1',
	addedAt: 1,
};

function mountFiles(props: Record<string, unknown> = {}) {
	return mount(AnswerTeamAttachments, {
		attachTo: document.body,
		props: {
			threadId: 'ct_1',
			contactId: 'c_1',
			contactName: 'Ana',
			attachments: [],
			uploads: [],
			suggestion: null,
			...props,
		},
		global: {
			plugins: [createTestI18n()],
			components: { InboxAttachSuggestion: AttachSuggestion },
		},
	});
}

describe('AnswerTeamAttachments menu', () => {
	it('focuses its first item on open, and closes on a click outside', async () => {
		const wrapper = mountFiles();
		await wrapper.get('[data-testid="answer-team-attach"]').trigger('click');
		await flushPromises();
		expect(document.activeElement).toBe(
			wrapper.get('[data-testid="answer-team-upload-choose"]').element
		);

		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await flushPromises();
		expect(wrapper.find('[role="menu"]').exists()).toBe(false);
	});

	it('closes on Esc, claims it (Answer mode stays) and hands focus back to Attach', async () => {
		const wrapper = mountFiles();
		await wrapper.get('[data-testid="answer-team-attach"]').trigger('click');
		await flushPromises();
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		document.activeElement!.dispatchEvent(event);
		await flushPromises();

		expect(wrapper.find('[role="menu"]').exists()).toBe(false);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(wrapper.get('[data-testid="answer-team-attach"]').element);
	});
});

describe('AnswerTeamAttachments', () => {
	it('mounts the agent suggestion; picking it attaches that Files row', async () => {
		const wrapper = mountFiles({
			suggestion: {
				inboundMessageId: 'in_1',
				query: 'invoice for September',
				ambiguous: false,
				candidates: [
					{
						fileId: 'sf_9',
						storageId: 'st_9',
						filename: 'invoice-2026-09.pdf',
						mimeType: 'application/pdf',
						fileSize: 86016,
						score: 0.91,
					},
				],
			},
		});
		await wrapper.get('[data-testid="attach-suggestion"]').trigger('click');
		expect(wrapper.emitted('attach-existing')?.[0]).toEqual(['semanticFile', 'sf_9']);
	});

	it('shows what is attached, a running copy and a failed one', () => {
		const wrapper = mountFiles({
			attachments: [
				ready,
				{ ...ready, index: 1, id: 'a2', filename: 'po.pdf', status: 'copying', url: null },
				{
					...ready,
					index: 2,
					id: 'a3',
					filename: 'old.pdf',
					status: 'failed',
					url: null,
					copyError: 'the file is gone',
				},
			],
		});
		const rows = wrapper.findAll('[data-testid="answer-team-attachment"]');
		expect(rows.map((r) => r.attributes('data-status'))).toEqual(['ready', 'copying', 'failed']);
		expect(rows[1]!.text()).toContain('Copying…');
		expect(rows[2]!.text()).toContain("Couldn't copy: the file is gone");
	});

	it('removes by position', async () => {
		const wrapper = mountFiles({ attachments: [ready, { ...ready, index: 1, id: 'a2' }] });
		await wrapper.findAll('[data-testid="answer-team-attachment-remove"]')[1]!.trigger('click');
		expect(wrapper.emitted('remove')?.[0]).toEqual([1]);
	});

	it('uploads the chosen files', async () => {
		const wrapper = mountFiles();
		const input = wrapper.get<HTMLInputElement>('[data-testid="answer-team-file-input"]');
		const file = new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' });
		Object.defineProperty(input.element, 'files', { value: [file] });
		await input.trigger('change');
		expect(wrapper.emitted('upload')?.[0]).toEqual([[file]]);
	});

	it('offers the contact’s files once the menu opens, this conversation first', async () => {
		contactFiles.value = [
			{ _id: 'sf_1', filename: 'invoice-2026-09.pdf', fileSize: 1, threadId: 'ct_1' },
			{ _id: 'sf_2', filename: 'contract.pdf', fileSize: 1, threadId: 'ct_other' },
			{ _id: 'sf_3', filename: 'here.pdf', fileSize: 1, threadId: 'ct_1' },
		];
		const wrapper = mountFiles({ attachments: [ready] });
		// Compact cards, not the whole-row `semanticFiles.listByContact`.
		expect(queryPaths).toEqual(['files.cards.listByContact']);
		// Nothing is read until the menu opens.
		expect((queryArgs[0] as () => unknown)()).toBe('skip');
		await wrapper.get('[data-testid="answer-team-attach"]').trigger('click');
		expect((queryArgs[0] as () => unknown)()).toEqual({ contactId: 'c_1', limit: 20 });

		const picks = wrapper.findAll('[data-testid="answer-team-pick-file"]');
		// sf_1 is already attached.
		expect(picks.map((p) => p.text())).toEqual([
			expect.stringContaining('here.pdf'),
			expect.stringContaining('contract.pdf'),
		]);
		await picks[1]!.trigger('click');
		expect(wrapper.emitted('attach-existing')?.[0]).toEqual(['semanticFile', 'sf_2']);
	});
});

describe('AnswerTeamAttachments upload queue', () => {
	const upload = (id: string, status: 'queued' | 'uploading', progress = 0) => ({
		id,
		filename: `${id}.pdf`,
		contentType: 'application/pdf',
		size: 1000,
		status,
		progress,
		indeterminate: status === 'queued',
		thumbUrl: null,
	});

	it('shows a queued chip as waiting, without a spinner', () => {
		const wrapper = mountFiles({ uploads: [upload('a', 'queued')] });
		const chip = wrapper.get('[data-testid="answer-team-upload"]');
		expect(chip.attributes('data-status')).toBe('queued');
		expect(chip.text()).toContain('Queued');
	});

	it('reads the queue in a polite status region that is mounted up front', async () => {
		const wrapper = mountFiles();
		const region = wrapper.get('[data-testid="answer-team-upload-queue-status"]');
		expect(region.attributes('role')).toBe('status');
		expect(region.attributes('aria-live')).toBe('polite');
		expect(region.text()).toBe('');

		await wrapper.setProps({
			uploads: [upload('a', 'uploading'), upload('b', 'queued'), upload('c', 'queued')],
		});
		expect(region.text()).toBe('2 files waiting to upload');

		// Byte progress leaves the queue, and so the message, alone.
		await wrapper.setProps({
			uploads: [upload('a', 'uploading', 0.5), upload('b', 'queued'), upload('c', 'queued')],
		});
		expect(region.text()).toBe('2 files waiting to upload');

		await wrapper.setProps({ uploads: [upload('b', 'uploading'), upload('c', 'uploading')] });
		expect(region.text()).toBe('No more files waiting to upload');
	});
});
