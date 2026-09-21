import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick, ref, shallowRef } from 'vue';

/**
 * What Owlat tells PostHog about a person is a privacy contract, not a detail:
 * the distinct id is already the user id, so the email address and display name
 * that used to ride along bought nothing and exported the user directory to a
 * third party. Same for the organization's name and slug. These cases pin the
 * payload shape so a "helpful" trait cannot come back unnoticed.
 */

const identify = vi.fn();
const setOrganization = vi.fn();
const reset = vi.fn();

const isAuthenticated = ref(false);
const user = ref<{ id: string; email: string; name: string } | null>(null);
const organizationId = ref<string | null>(null);
const instance = shallowRef<object | null>(null);

async function loadComposable() {
	vi.stubGlobal('useAuth', () => ({ isAuthenticated, user }));
	vi.stubGlobal('useOrganizationContext', () => ({
		organizationId,
		organization: ref({ name: 'Acme GmbH', slug: 'acme' }),
	}));
	vi.stubGlobal('usePostHog', () => ({
		identify,
		setOrganization,
		reset,
		getInstance: () => instance.value,
	}));
	vi.resetModules();
	const mod = await import('../usePostHogIdentity');
	return mod.usePostHogIdentity;
}

describe('usePostHogIdentity', () => {
	beforeEach(() => {
		identify.mockClear();
		setOrganization.mockClear();
		reset.mockClear();
		isAuthenticated.value = false;
		user.value = null;
		organizationId.value = null;
		instance.value = null;
	});

	it('identifies by user id alone — no email, no name', async () => {
		const usePostHogIdentity = await loadComposable();
		instance.value = {};
		usePostHogIdentity();

		isAuthenticated.value = true;
		user.value = { id: 'user_1', email: 'ada@example.com', name: 'Ada Lovelace' };
		await nextTick();

		expect(identify).toHaveBeenCalledWith('user_1');
		const payload = JSON.stringify(identify.mock.calls);
		expect(payload).not.toContain('ada@example.com');
		expect(payload).not.toContain('Ada Lovelace');
	});

	it('groups by organization id alone — no workspace name or slug', async () => {
		const usePostHogIdentity = await loadComposable();
		instance.value = {};
		usePostHogIdentity();

		organizationId.value = 'org_1';
		await nextTick();

		expect(setOrganization).toHaveBeenCalledWith('org_1');
		const payload = JSON.stringify(setOrganization.mock.calls);
		expect(payload).not.toContain('Acme GmbH');
		expect(payload).not.toContain('acme');
	});

	it('sends nothing while the client is absent, and identifies when it appears', async () => {
		const usePostHogIdentity = await loadComposable();
		usePostHogIdentity();

		isAuthenticated.value = true;
		user.value = { id: 'user_1', email: 'ada@example.com', name: 'Ada Lovelace' };
		organizationId.value = 'org_1';
		await nextTick();

		// `analytics.posthog` has not resolved on yet — no client, no calls.
		expect(identify).not.toHaveBeenCalled();
		expect(setOrganization).not.toHaveBeenCalled();

		// The flag flips on later in the session; identity must not stay lost.
		instance.value = {};
		await nextTick();

		expect(identify).toHaveBeenCalledWith('user_1');
		expect(setOrganization).toHaveBeenCalledWith('org_1');
	});

	it('resets on sign-out', async () => {
		const usePostHogIdentity = await loadComposable();
		instance.value = {};
		isAuthenticated.value = true;
		usePostHogIdentity();

		isAuthenticated.value = false;
		await nextTick();

		expect(reset).toHaveBeenCalled();
	});
});
