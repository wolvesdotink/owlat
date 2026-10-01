// @vitest-environment happy-dom
/**
 * One banner slot, priority-ordered.
 *
 * Three advisory strips used to mount independently, so an offline device on a
 * sealed instance with a non-empty reply queue got a three-high stack between
 * the folder title and the first message. Exactly one renders now — offline >
 * sealed > reply queue — and yielding is not losing: the moment the higher one
 * is dismissed or resolves, the next takes the slot.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxBannerSlot from '../PostboxBannerSlot.vue';

const sealedFlagOn = ref(true);
const hasSeenSealedNudge = ref(false);
const replyQueueCount = ref(0);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (name: string) => name === 'sealedMail' && sealedFlagOn.value,
	}));
	vi.stubGlobal('usePostboxSettings', () => ({
		hasSeenSealedMailNudge: hasSeenSealedNudge,
		dismissSealedMailNudge: vi.fn(async () => {}),
	}));
	vi.stubGlobal('usePostboxReplyQueue', () => ({ count: replyQueueCount }));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;
beforeEach(() => {
	stateBuckets = new Map();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	sealedFlagOn.value = true;
	hasSeenSealedNudge.value = false;
	replyQueueCount.value = 0;
});

const stubs = {
	PostboxOfflineBanners: { props: ['isOffline'], template: '<div class="offline" />' },
	PostboxAnswerDraftBar: { template: '<div class="draft" />' },
	PostboxSealedMailNudge: { template: '<div class="sealed" />' },
	PostboxReplyQueueStrip: { props: ['mailboxId', 'folderRole'], template: '<div class="queue" />' },
};

function mountSlot(props: Record<string, unknown> = {}) {
	return mount(PostboxBannerSlot, {
		props: {
			mailboxId: 'mbx' as never,
			folderRole: 'inbox',
			isOffline: false,
			queuedCount: 0,
			failedCount: 0,
			...props,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
}

const shown = (w: ReturnType<typeof mountSlot>) =>
	['offline', 'draft', 'sealed', 'queue'].filter((cls) => w.find(`.${cls}`).exists());

/** A reply left in Answer mode, as the page files it on the way out. */
function leaveDraft(mailboxId = 'mbx') {
	stateBuckets.set(
		'answer:left-draft',
		ref({
			draftId: 'draft-1',
			messageId: 'msg-1',
			mailboxId,
			kind: null,
			recipient: 'Jonas',
		})
	);
}

describe('PostboxBannerSlot', () => {
	it('shows connectivity above everything else, and only it', () => {
		replyQueueCount.value = 2;
		expect(shown(mountSlot({ isOffline: true }))).toEqual(['offline']);
	});

	it('keeps the slot for undeliverable queued sends once back online', () => {
		expect(shown(mountSlot({ failedCount: 1 }))).toEqual(['offline']);
	});

	it('hands the slot to the sealed nudge once connectivity resolves', () => {
		replyQueueCount.value = 2;
		expect(shown(mountSlot())).toEqual(['sealed']);
	});

	it('hands it on to the reply queue once the nudge is dismissed', () => {
		hasSeenSealedNudge.value = true;
		replyQueueCount.value = 2;
		expect(shown(mountSlot())).toEqual(['queue']);
	});

	it('renders nothing when no strip has anything to say', () => {
		hasSeenSealedNudge.value = true;
		expect(shown(mountSlot())).toEqual([]);
	});

	it('never renders the reply-queue strip outside the inbox', () => {
		hasSeenSealedNudge.value = true;
		replyQueueCount.value = 2;
		expect(shown(mountSlot({ folderRole: 'archive' }))).toEqual([]);
	});

	it('offers a draft left in Answer mode right below connectivity, above the nudges', () => {
		replyQueueCount.value = 2;
		leaveDraft();
		expect(shown(mountSlot())).toEqual(['draft']);
		leaveDraft();
		expect(shown(mountSlot({ isOffline: true }))).toEqual(['offline']);
	});

	it('offers the draft only on its own mailbox', () => {
		sealedFlagOn.value = false;
		leaveDraft('another-mailbox');
		expect(shown(mountSlot())).toEqual([]);
	});
});
