/**
 * The label and move pickers offer one mailbox's labels and folders. In a list
 * that spans mailboxes (All inboxes) that is the mailbox of the row the picker
 * was opened on; in one mailbox's folder it stays the list's mailbox.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxRowPickers } from '../usePostboxRowPickers';

let labelsMailbox: Ref<string | null> | null = null;
let foldersMailbox: Ref<string | null> | null = null;

beforeAll(() => {
	vi.stubGlobal('usePostboxLabels', (mailboxId: Ref<string | null>) => {
		labelsMailbox = mailboxId;
		return { labels: ref([]), setOnMessage: vi.fn() };
	});
	vi.stubGlobal('usePostboxFolders', (mailboxId: Ref<string | null>) => {
		foldersMailbox = mailboxId;
		return { folders: ref([]) };
	});
	vi.stubGlobal('usePostboxMailboxTransfer', () => ({
		targets: ref([]),
		isSourceConnected: ref(false),
		confirmTarget: vi.fn(),
		transfer: vi.fn(),
	}));
});

beforeEach(() => {
	labelsMailbox = null;
	foldersMailbox = null;
});

const owners: Record<string, string> = { m_home: 'mb_home', m_work: 'mb_work' };
const msgId = (id: string) => id as Id<'mailMessages'>;

function pickers(listMailbox: string | null) {
	return usePostboxRowPickers({
		mailboxId: ref(listMailbox as Id<'mailboxes'> | null),
		mailboxOf: (id) => owners[id] ?? null,
		folderRole: ref('inbox'),
		snoozeMsg: vi.fn(),
		snoozeThread: vi.fn(),
		moveMsg: vi.fn(),
	});
}

describe('usePostboxRowPickers', () => {
	it('offers the labels and folders of the row it opened on, in a list that spans mailboxes', () => {
		const p = pickers(null);
		p.openLabel(msgId('m_work'));
		expect(labelsMailbox?.value).toBe('mb_work');
		p.openMove(msgId('m_home'));
		expect(foldersMailbox?.value).toBe('mb_home');
	});

	it("keeps the list's own mailbox in one mailbox's folder", () => {
		const p = pickers('mb_home');
		p.openLabel(msgId('m_work'));
		expect(labelsMailbox?.value).toBe('mb_home');
	});
});
