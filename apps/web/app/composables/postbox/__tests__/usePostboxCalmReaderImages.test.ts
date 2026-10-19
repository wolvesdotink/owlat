/**
 * The calm reader routes image banners into Details, except the latest one's
 * while it is the notice. A suspicious message's banner never goes there: its
 * images never load on their own, so "Show images" stays beside its body on
 * every expanded card, not only the latest one.
 */
import { describe, it, expect, vi } from 'vitest';
import { effectScope, ref } from 'vue';

vi.mock('~/composables/useAnswerMode', () => ({
	useAnswerLeftDraft: () => ({ left: ref(null) }),
}));
vi.mock('~/composables/postbox/usePostboxWhyHere', () => ({
	usePostboxWhyHere: () => ({ open: vi.fn() }),
}));
vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));

const { usePostboxCalmReader } = await import('../usePostboxCalmReader');

function setup() {
	const details = document.createElement('div');
	const older = { _id: 'old', fromAddress: 'a@b.example' };
	const latest = { _id: 'new', fromAddress: 'a@b.example' };
	const scope = effectScope();
	const calm = scope.run(() =>
		usePostboxCalmReader({
			threadKey: () => 't1',
			mailboxId: () => 'mb',
			threadId: () => 't1',
			placement: () => undefined,
			messages: ref([older, latest]),
			latest: ref(latest),
			expanded: ref(new Set(['old', 'new'])),
			keyChanged: ref(false),
			isSigned: ref(false),
			detailsEl: ref(details),
		})
	)!;
	return { calm, details };
}

describe('usePostboxCalmReader image banners', () => {
	it('keeps an older suspicious message banner in place, others in Details', () => {
		const { calm, details } = setup();
		calm.onImageState('old', 'trackers-blocked');
		expect(calm.cardOf('old').imageBannerTo).toBe(details);

		calm.onImageState('old', 'suspicious');
		expect(calm.cardOf('old').imageBannerTo).toBeNull();
	});

	it('keeps the latest suspicious banner in place and names it in the summary', () => {
		const { calm } = setup();
		calm.onImageState('new', 'suspicious');
		expect(calm.cardOf('new').imageBannerTo).toBeNull();
		expect(calm.summary.value).toBe('postbox.reader.summary.imagesOff');
	});
});
