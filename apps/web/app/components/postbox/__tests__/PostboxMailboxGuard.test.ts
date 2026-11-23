/**
 * PostboxMailboxGuard — the honest no-mailbox empty state.
 *
 * Focus here: the `reserved` branch renders DIFFERENT progress copy depending on
 * whether the reservation's sending domain has verified yet. An early-instance
 * invite (domain still verifying) must read as "reserved, activates when your
 * domain verifies" — progress, not a stalled "being set up right now" or a dead
 * end. Once the domain verifies, the reservation reads as actively provisioning.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PostboxMailboxGuard from '../PostboxMailboxGuard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

type FreshStatus = {
	hasMailbox: boolean;
	reservedAddress: string | null;
	reservationAwaitingDomain: boolean;
	hasOpenRequest: boolean;
};

// The composables are Nuxt auto-imports the SFC references as bare globals — a
// module-level ref the tests reassign so each mount reads a fresh status.
const role = ref<'owner' | 'admin' | 'editor' | 'member'>('member');
const roleLoading = ref(false);
const externalOn = ref(false);
const postboxOn = ref(true);
const flagsLoading = ref(false);
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
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) =>
			(flag === 'mail.external' && externalOn.value) || (flag === 'postbox' && postboxOn.value),
		isLoading: flagsLoading,
	}));
	vi.stubGlobal('usePermissions', () => ({
		isAdmin: computed(() => role.value === 'owner' || role.value === 'admin'),
		isRoleLoading: roleLoading,
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	role.value = 'member';
	roleLoading.value = false;
	externalOn.value = false;
	postboxOn.value = true;
	flagsLoading.value = false;
});

function mountGuard() {
	return mount(PostboxMailboxGuard, {
		props: { mailboxId: null, loading: false },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				NuxtLink: true,
				UiButton: { props: ['to'], template: '<button :data-to="to"><slot /></button>' },
			},
		},
	});
}

describe('PostboxMailboxGuard reserved copy', () => {
	it('renders the awaiting-domain progress copy for a pre-verification reservation', () => {
		freshStatusRef.value = {
			hasMailbox: false,
			reservedAddress: 'marcel@owlat.test',
			reservationAwaitingDomain: true,
			hasOpenRequest: false,
		};
		const w = mountGuard();

		expect(w.find('[data-testid="mailbox-guard-reserved"]').exists()).toBe(true);
		expect(w.find('[data-testid="mailbox-guard-reserved-awaiting"]').exists()).toBe(true);
		expect(w.text()).toContain('marcel@owlat.test');
		expect(w.text()).toContain('sending domain verifies');
		// Not the dead-end state.
		expect(w.find('[data-testid="mailbox-guard-deadend"]').exists()).toBe(false);
	});

	it('renders the standard provisioning copy once the domain is verified', () => {
		freshStatusRef.value = {
			hasMailbox: false,
			reservedAddress: 'marcel@owlat.test',
			reservationAwaitingDomain: false,
			hasOpenRequest: false,
		};
		const w = mountGuard();

		expect(w.find('[data-testid="mailbox-guard-reserved"]').exists()).toBe(true);
		expect(w.find('[data-testid="mailbox-guard-reserved-awaiting"]').exists()).toBe(false);
		expect(w.text()).toContain('being set up');
	});
});

describe('PostboxMailboxGuard failed mailbox read (#721)', () => {
	it('shows the error with Try again instead of a no-mailbox state', async () => {
		freshStatusRef.value = {
			hasMailbox: false,
			reservedAddress: null,
			reservationAwaitingDomain: false,
			hasOpenRequest: false,
		};
		const w = mount(PostboxMailboxGuard, {
			props: {
				mailboxId: null,
				loading: false,
				error: new Error('[CONVEX Q(mail/mailbox/identity:list)] Server Error'),
			},
			global: { plugins: [createTestI18n()], stubs: { NuxtLink: true } },
		});

		expect(w.text()).toContain('Failed to load');
		expect(w.find('[data-testid="mailbox-guard-deadend"]').exists()).toBe(false);
		expect(w.find('[data-testid="mailbox-guard-external"]').exists()).toBe(false);
		const retry = w.findAll('button').find((button) => button.text() === 'Try again');
		await retry!.trigger('click');
		expect(w.emitted('retry')).toHaveLength(1);
	});
});

describe('PostboxMailboxGuard with no mailbox and no reservation', () => {
	beforeEach(() => {
		freshStatusRef.value = {
			hasMailbox: false,
			reservedAddress: null,
			reservationAwaitingDomain: false,
			hasOpenRequest: false,
		};
	});

	it('sends an owner to set up a mailbox instead of asking an admin', () => {
		role.value = 'owner';
		const w = mountGuard();

		const deadEnd = w.get('[data-testid="mailbox-guard-deadend"]');
		const cta = deadEnd.get('button');
		expect(cta.attributes('data-to')).toBe('/dashboard/preferences/add-account');
		expect(cta.text()).toBe('Set up a mailbox');
		expect(deadEnd.text()).not.toContain('Ask an admin');
		expect(deadEnd.text()).not.toContain('Only an admin');
	});

	it('offers an admin no link while mail is turned off on the instance', () => {
		role.value = 'owner';
		postboxOn.value = false;
		const w = mountGuard();

		const deadEnd = w.get('[data-testid="mailbox-guard-deadend"]');
		// The add-account page needs `postbox` or `mail.external`; a link there
		// would only bounce back to the dashboard.
		expect(deadEnd.find('button').exists()).toBe(false);
		expect(deadEnd.text()).not.toContain('Ask an admin');
	});

	it('keeps the ask-an-admin request for a member', () => {
		const w = mountGuard();

		const deadEnd = w.get('[data-testid="mailbox-guard-deadend"]');
		const cta = deadEnd.get('button');
		expect(cta.attributes('data-to')).toBeUndefined();
		expect(cta.text()).toBe('Ask an admin');
		expect(deadEnd.text()).not.toContain('Set up a mailbox');
	});

	it('does not show the member dead-end to an admin while the role resolves', () => {
		role.value = 'admin';
		roleLoading.value = true;
		const w = mountGuard();

		expect(w.find('[data-testid="mailbox-guard-deadend"]').exists()).toBe(false);
	});

	it('waits for the flags before it picks between the dead-end and connecting', async () => {
		externalOn.value = true;
		flagsLoading.value = true;
		const w = mountGuard();
		expect(w.find('[data-testid="mailbox-guard-deadend"]').exists()).toBe(false);
		expect(w.find('[data-testid="mailbox-guard-external"]').exists()).toBe(false);

		flagsLoading.value = false;
		await nextTick();
		expect(w.find('[data-testid="mailbox-guard-external"]').exists()).toBe(true);
	});

	it('sends a member who may connect an account to the connect wizard', () => {
		externalOn.value = true;
		const w = mountGuard();

		const external = w.get('[data-testid="mailbox-guard-external"]');
		// Creating a hosted mailbox on the add-account page is admin-only.
		expect(external.findAll('button').map((b) => b.attributes('data-to'))).toEqual([
			'/dashboard/postbox/migrate',
		]);
	});

	it('offers an admin who may connect an account a hosted mailbox as well', () => {
		externalOn.value = true;
		// `mail.external` alone makes the add-account page reachable.
		postboxOn.value = false;
		role.value = 'admin';
		const w = mountGuard();

		const buttons = w.get('[data-testid="mailbox-guard-external"]').findAll('button');
		expect(buttons.map((b) => [b.text(), b.attributes('data-to')])).toEqual([
			['Connect an account', '/dashboard/postbox/migrate'],
			['Set up a mailbox', '/dashboard/preferences/add-account'],
		]);
	});
});
