// @vitest-environment happy-dom
/**
 * The member-readable sending-health card (plan idea 12), mounted against the
 * REAL message catalog.
 *
 * Convex is stubbed at the composable seam: the card's job here is to prove it
 * reads the member's OWN identity and OWN send stats and turns them into words
 * a member can act on — including the point of the whole card, which is that a
 * regular member gets an answer at all without an admin page.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import PostboxSendingHealthCard from '../PostboxSendingHealthCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { SendingHealthStats } from '~/utils/postboxSendingHealth';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Identity = {
	address: string;
	domainVerified: boolean;
	alignment: 'aligned' | 'misaligned' | 'unknown';
	alignmentReason?: string | null;
};

const identities = ref<Identity[]>([]);
const stats = ref<SendingHealthStats | null>(null);
const loading = ref(false);

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePostboxMailbox', () => ({
		currentMailbox: ref({ _id: 'mb_1', address: 'me@hinterland.camp' }),
	}));
	// Both reads are mailbox-scoped; the card only ever asks for the mailbox it
	// is already looking at, so one stub serves both by shape.
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: () => unknown) => {
		void args;
		return { data: nextRead(), isLoading: loading };
	});
});

// `useConvexQuery` is called twice in setup order: identities, then stats.
let readCount = 0;
function nextRead() {
	readCount += 1;
	return readCount % 2 === 1 ? identities : stats;
}

beforeEach(() => {
	readCount = 0;
	loading.value = false;
	identities.value = [
		{ address: 'me@hinterland.camp', domainVerified: true, alignment: 'aligned' },
	];
	stats.value = {
		sends: 12,
		attempts: 14,
		accepted: 14,
		bounced: 0,
		failed: 0,
		pending: 0,
		latestFailure: null,
	};
});

const iconStub = { props: ['name'], template: '<span />' };

function mountCard() {
	// The two reads are handed out in setup order, so the counter has to start
	// fresh for every mount, not merely for every test.
	readCount = 0;
	return mount(PostboxSendingHealthCard, {
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
	});
}

describe('PostboxSendingHealthCard', () => {
	it('answers the question a member could not answer before', () => {
		const text = mountCard().text();
		expect(text).toContain('Is my mail arriving?');
		expect(text).toContain('Your mail is arriving');
		expect(text).toContain('Nothing to fix');
	});

	it('reports on the address the member actually sends as', () => {
		identities.value = [
			{ address: 'someone-else@hinterland.camp', domainVerified: false, alignment: 'unknown' },
			{ address: 'me@hinterland.camp', domainVerified: true, alignment: 'aligned' },
		];
		expect(mountCard().text()).toContain('me@hinterland.camp is verified');
	});

	it('names the newest bounce’s own next action as the one thing to fix', () => {
		stats.value = {
			sends: 20,
			attempts: 20,
			accepted: 19,
			bounced: 1,
			failed: 0,
			pending: 0,
			latestFailure: {
				address: 'jonas@acme.example',
				state: 'bounced',
				at: 1_770_000_000_000,
				bounceMessage: '550 5.1.1 no mailbox by that name',
			},
		};
		const text = mountCard().text();
		expect(text).toContain('Worth a look');
		expect(text).toContain('Check the spelling');
		expect(text).toContain("1 of 20 recent deliveries didn't get through");
	});

	it('says sending is off when the member’s domain is not verified', () => {
		identities.value = [
			{ address: 'me@hinterland.camp', domainVerified: false, alignment: 'unknown' },
		];
		const text = mountCard().text();
		expect(text).toContain('Sending is off');
		expect(text).toContain('sending from it is turned off');
	});

	it('greets a member who has never sent anything without a warning', () => {
		stats.value = {
			sends: 0,
			attempts: 0,
			accepted: 0,
			bounced: 0,
			failed: 0,
			pending: 0,
			latestFailure: null,
		};
		const text = mountCard().text();
		expect(text).toContain('Your mail is arriving');
		expect(text).toContain("haven't sent anything from here yet");
	});

	it('shows a skeleton while the reads are in flight', () => {
		loading.value = true;
		const wrapper = mountCard();
		expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Your mail is arriving');
	});
});
