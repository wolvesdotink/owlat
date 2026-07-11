// @vitest-environment happy-dom
/**
 * PostboxMailboxGuard — the honest no-mailbox empty state.
 *
 * Focus here: the `reserved` branch renders DIFFERENT progress copy depending on
 * whether the reservation's sending domain has verified yet. An early-instance
 * invite (domain still verifying) must read as "reserved, activates when your
 * domain verifies" — progress, not a stalled "being set up right now" or a dead
 * end. Once the domain verifies, the reservation reads as actively provisioning.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import PostboxMailboxGuard from '../PostboxMailboxGuard.vue';

type FreshStatus = {
	hasMailbox: boolean;
	reservedAddress: string | null;
	reservationAwaitingDomain: boolean;
	hasOpenRequest: boolean;
};

// The composables are Nuxt auto-imports the SFC references as bare globals — a
// module-level ref the tests reassign so each mount reads a fresh status.
const freshStatusRef = ref<FreshStatus>({
	hasMailbox: false,
	reservedAddress: null,
	reservationAwaitingDomain: false,
	hasOpenRequest: false,
});

beforeAll(() => {
	vi.stubGlobal('useConvexQuery', () => ({
		data: freshStatusRef,
		isLoading: ref(false),
	}));
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
});

function mountGuard() {
	return mount(PostboxMailboxGuard, {
		props: { mailboxId: null, loading: false },
		global: { stubs: { Icon: true, NuxtLink: true, UiButton: true } },
	});
}

describe('PostboxMailboxGuard reserved copy', () => {
	it('renders the awaiting-domain progress copy for a pre-verification reservation', () => {
		freshStatusRef.value = {
			hasMailbox: false,
			reservedAddress: 'marcel@hinterland.camp',
			reservationAwaitingDomain: true,
			hasOpenRequest: false,
		};
		const w = mountGuard();

		expect(w.find('[data-testid="mailbox-guard-reserved"]').exists()).toBe(true);
		expect(w.find('[data-testid="mailbox-guard-reserved-awaiting"]').exists()).toBe(true);
		expect(w.text()).toContain('marcel@hinterland.camp');
		expect(w.text()).toContain('sending domain verifies');
		// Not the dead-end state.
		expect(w.find('[data-testid="mailbox-guard-deadend"]').exists()).toBe(false);
	});

	it('renders the standard provisioning copy once the domain is verified', () => {
		freshStatusRef.value = {
			hasMailbox: false,
			reservedAddress: 'marcel@hinterland.camp',
			reservationAwaitingDomain: false,
			hasOpenRequest: false,
		};
		const w = mountGuard();

		expect(w.find('[data-testid="mailbox-guard-reserved"]').exists()).toBe(true);
		expect(w.find('[data-testid="mailbox-guard-reserved-awaiting"]').exists()).toBe(false);
		expect(w.text()).toContain('being set up');
	});
});
