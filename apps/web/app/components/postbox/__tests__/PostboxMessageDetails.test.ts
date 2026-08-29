// @vitest-environment happy-dom
/**
 * PostboxMessageDetails — the disclosure that makes the sender badge falsifiable
 * (UX plan idea 52), mounted against the REAL message catalog.
 *
 * Two behaviours only this level can pin: the header query is SKIPPED until the
 * panel is opened (a disclosure nobody opens must cost nothing), and "download
 * original" turns the raw `.eml` into a real file rather than a spinner that
 * stops.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick } from 'vue';

import PostboxMessageDetails from '../PostboxMessageDetails.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// The generated Convex api object is only a path into the (stubbed) query
// composable — a self-returning proxy stands in for any path.
vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const DETAILS = {
	fromAddress: 'Northwind <hello@northwind.studio>',
	replyToAddress: 'billing@other-domain.example',
	rfc822MessageId: '<abc@northwind.studio>',
	spfResult: 'pass',
	dkimResult: 'pass',
	dmarcResult: 'pass',
	envelopeFromDomain: 'bounce.northwind.studio',
	dkimSigningDomain: 'northwind.studio',
};

/** Args the component handed the query on each (re)subscribe. */
const queryArgs = vi.fn();
const loadRawEml = vi.fn(async () => 'From: hello@northwind.studio\r\n\r\nhi');
const showToast = vi.fn();
const createObjectURL = vi.fn(() => 'blob:mock');
const revokeObjectURL = vi.fn();

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('loadRawEml', (id: string) => loadRawEml(id));
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		const data = ref<unknown>(undefined);
		const isLoading = ref(false);
		// Mirror the real composable: re-evaluate the args factory reactively and
		// only "resolve" when it is not skipping.
		watchEffect(() => {
			const resolved = args();
			queryArgs(resolved);
			data.value = resolved === 'skip' ? undefined : DETAILS;
		});
		return { data, isLoading, error: ref(null), isRefetching: ref(false), refetch: vi.fn() };
	});
	Object.assign(URL, { createObjectURL, revokeObjectURL });
});

beforeEach(() => {
	queryArgs.mockClear();
	loadRawEml.mockClear();
	showToast.mockClear();
	createObjectURL.mockClear();
});

const iconStub = { props: ['name'], template: '<span />' };

function mountPanel() {
	return mount(PostboxMessageDetails, {
		props: { messageId: 'msg-1' },
		global: { plugins: [createTestI18n()], stubs: { Icon: iconStub } },
	});
}

describe('PostboxMessageDetails', () => {
	it('skips the header query until the disclosure is opened', async () => {
		const w = mountPanel();
		expect(queryArgs).toHaveBeenLastCalledWith('skip');
		expect(w.find('[data-testid="message-details-panel"]').exists()).toBe(false);

		await w.find('[data-testid="message-details-toggle"]').trigger('click');
		expect(queryArgs).toHaveBeenLastCalledWith({ messageId: 'msg-1' });
		expect(w.find('[data-testid="message-details-panel"]').exists()).toBe(true);
	});

	it('renders each verdict beside the domain it authenticated', async () => {
		const w = mountPanel();
		await w.find('[data-testid="message-details-toggle"]').trigger('click');

		const spf = w.find('[data-testid="message-details-row-spf"]');
		expect(spf.text()).toContain('SPF');
		expect(spf.text()).toContain('pass');
		expect(spf.text()).toContain('bounce.northwind.studio');
		expect(w.find('[data-testid="message-details-row-dkim"]').text()).toContain('northwind.studio');
	});

	it('flags a Reply-To that points at another domain', async () => {
		const w = mountPanel();
		await w.find('[data-testid="message-details-toggle"]').trigger('click');
		const replyTo = w.find('[data-testid="message-details-row-replyTo"]');
		expect(replyTo.text()).toContain('billing@other-domain.example');
		expect(replyTo.text()).toContain('different domain from the sender');
	});

	it('downloads the original .eml as a real file', async () => {
		const w = mountPanel();
		await w.find('[data-testid="message-details-toggle"]').trigger('click');
		await w.find('[data-testid="message-details-download"]').trigger('click');
		await nextTick();
		await nextTick();

		expect(loadRawEml).toHaveBeenCalledWith('msg-1');
		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(showToast).not.toHaveBeenCalled();
	});

	it('says so when the original cannot be fetched, instead of failing silently', async () => {
		loadRawEml.mockResolvedValueOnce(null as unknown as string);
		const w = mountPanel();
		await w.find('[data-testid="message-details-toggle"]').trigger('click');
		await w.find('[data-testid="message-details-download"]').trigger('click');
		await nextTick();
		await nextTick();

		expect(createObjectURL).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledTimes(1);
	});

	it('collapses again when the reader moves to another message', async () => {
		const w = mountPanel();
		await w.find('[data-testid="message-details-toggle"]').trigger('click');
		expect(w.find('[data-testid="message-details-panel"]').exists()).toBe(true);

		await w.setProps({ messageId: 'msg-2' });
		expect(w.find('[data-testid="message-details-panel"]').exists()).toBe(false);
	});
});
