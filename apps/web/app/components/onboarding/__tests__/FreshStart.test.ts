// @vitest-environment happy-dom
/**
 * The fresh-start setup — the default welcome branch.
 *
 * Two things are pinned here.
 *
 * COPY: the screen is fully extracted, so it is mounted against the REAL `en`
 * catalog and asserted on the sentences a member reads — including the
 * notification-scope option labels, which used to be English constants in
 * `~/utils/postboxNotify` and are now catalog messages.
 *
 * THE "SENDING IS READY NOW" LATCH: `sawBlocked` is deliberately permanent —
 * once a member has been told sending isn't set up, a transport landing while
 * they are still on this screen has to SAY so instead of quietly swapping the
 * note for a button. A permanent latch has to be armed by a settled answer and
 * nothing else: the transport probe also stops loading when it errors or times
 * out, and `canSend` collapses that `undefined` to `false`, so latching on it
 * would announce "sending just got set up" about an instance that could send
 * the whole time.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

import FreshStart from '../FreshStart.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

type Mailbox = { _id: string; address: string; displayName?: string };

const mailbox = ref<Mailbox | null>(null);
const mailboxLoading = ref(false);
/** The transport probe: `undefined` is "no answer yet", not "cannot send". */
const canSendData = ref<boolean | undefined>(undefined);
const transportLoading = ref(true);
const notifyAbout = ref<'everything' | 'people-important' | 'nothing'>('everything');
const setNotifyAbout = vi.fn(async () => undefined);

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		navigateTo: vi.fn(),
		useAuth: () => ({ user: ref({ id: 'user-1', name: 'Marcel Pfeifer' }) }),
		usePostboxMailbox: () => ({ currentMailbox: mailbox, isLoading: mailboxLoading }),
		useOrganizationQuery: () => ({ data: canSendData, isLoading: transportLoading }),
		usePostboxSettings: () => ({
			notifyAbout,
			setNotifyAbout,
			isLoading: ref(false),
		}),
		useBackendOperation: () => ({ run: vi.fn(async () => null), isLoading: ref(false) }),
	});
});

beforeEach(() => {
	mailbox.value = { _id: 'mailbox-1', address: 'marcel@hinterland.camp' };
	mailboxLoading.value = false;
	canSendData.value = undefined;
	transportLoading.value = true;
	notifyAbout.value = 'everything';
	vi.clearAllMocks();
});

function mountFreshStart() {
	return mount(FreshStart, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { template: '<span />' },
				UiSpinner: { template: '<span />' },
				PostboxMailboxGuard: { template: '<div data-testid="mailbox-guard" />' },
			},
		},
	});
}

/** Deliver a settled answer from the transport probe. */
async function settleTransport(canSend: boolean) {
	canSendData.value = canSend;
	transportLoading.value = false;
	await flushPromises();
}

describe('FreshStart copy', () => {
	it('renders the two-minute setup from the catalog', async () => {
		await settleTransport(true);
		const w = mountFreshStart();

		expect(w.text()).toContain("You'll send from marcel@hinterland.camp.");
		expect(w.text()).toContain('Your name');
		expect(w.text()).toContain('This is the name people see on your mail.');
		expect(w.text()).toContain('Signature');
		expect(w.text()).toContain('(optional)');
		expect(w.text()).toContain('Notify me about');
		expect(w.text()).toContain("A few things you'll love");
		expect(w.text()).toContain('Skip for now');
		expect(w.text()).toContain('Go to my inbox');
		expect(w.get('#fresh-display-name').attributes('placeholder')).toBe('e.g. Marcel Pfeifer');
		expectFullyLocalized(w);
	});

	it('labels every notification scope through the catalog, not a hardcoded constant', async () => {
		await settleTransport(true);
		const w = mountFreshStart();

		const labels = w.findAll('#fresh-notify option').map((option) => option.text());
		expect(labels).toEqual(['Everything', 'People & important only', 'Nothing']);
		// The stable union is still what gets stored.
		const values = w.findAll('#fresh-notify option').map((option) => option.attributes('value'));
		expect(values).toEqual(['everything', 'people-important', 'nothing']);
		expectFullyLocalized(w);
	});

	it('hands a member with no mailbox to the honest next-step guard', async () => {
		mailbox.value = null;
		await settleTransport(false);
		const w = mountFreshStart();

		expect(w.find('[data-testid="mailbox-guard"]').exists()).toBe(true);
		expect(w.text()).not.toContain('Notify me about');
	});
});

describe('FreshStart sending-readiness latch', () => {
	it('holds the row while the transport probe is still loading', () => {
		const w = mountFreshStart();

		expect(w.text()).toContain('Checking whether sending is ready…');
		// Neither of the two settled states may flash before the answer lands.
		expect(w.text()).not.toContain('Your admin is still setting up sending');
		expect(w.text()).not.toContain('Send yourself a test');
		expectFullyLocalized(w);
	});

	it('drives loading → blocked → ready and says sending just got set up', async () => {
		const w = mountFreshStart();
		expect(w.text()).toContain('Checking whether sending is ready…');

		await settleTransport(false);
		expect(w.text()).toContain('Your admin is still setting up sending');
		expect(w.text()).not.toContain('Email myself');

		await settleTransport(true);
		expect(w.text()).toContain('Sending is ready now');
		expect(w.text()).toContain('Sending just got set up');
		expect(w.text()).toContain('Email myself');
		expectFullyLocalized(w);
	});

	it('gives a member who was never blocked the plain test-send row', async () => {
		await settleTransport(true);
		const w = mountFreshStart();

		expect(w.text()).toContain('Send yourself a test');
		expect(w.text()).not.toContain('Sending is ready now');
		expectFullyLocalized(w);
	});

	it('keeps the latch armed once a real refusal has been shown', async () => {
		const w = mountFreshStart();
		await settleTransport(false);
		await settleTransport(true);
		expect(w.text()).toContain('Sending is ready now');

		// A later flap back and forth must not un-say it either.
		await settleTransport(false);
		expect(w.text()).toContain('Your admin is still setting up sending');
		await settleTransport(true);
		expect(w.text()).toContain('Sending is ready now');
	});

	it('does not arm the latch from a probe that gave up without answering', async () => {
		const w = mountFreshStart();

		// `useConvexQuery` also leaves loading on an error or a timeout — with no
		// data. That is not the instance telling us it cannot send.
		canSendData.value = undefined;
		transportLoading.value = false;
		await flushPromises();
		expect(w.text()).toContain('Your admin is still setting up sending');

		await settleTransport(true);
		expect(w.text()).toContain('Send yourself a test');
		expect(w.text()).not.toContain('Sending is ready now');
		expectFullyLocalized(w);
	});
});
