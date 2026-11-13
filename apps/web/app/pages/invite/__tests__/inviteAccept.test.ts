/**
 * Someone invited without an account creates one on the way in, and the
 * invitation waits for them to confirm their email instead of failing.
 *
 * The server refuses to accept an invitation for an unverified address (an
 * existing member can see pending invitation IDs, so holding the link proves
 * nothing). A brand-new account is unverified, so the page has to say what is
 * missing and offer the email again, not end on "Invitation error".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import UiButton from '@owlat/ui/components/ui/Button.vue';

type SessionUser = { email: string; emailVerified: boolean };

let sessionUser: SessionUser | null = null;
let activeOrganizationId: string | null = null;
const getSession = vi.fn(async (_options?: unknown) => ({
	data: sessionUser ? { user: sessionUser, session: { activeOrganizationId } } : null,
}));
const acceptInvitation = vi.fn(
	async (_args: unknown): Promise<{ data: unknown; error: unknown }> => ({
		data: {},
		error: null,
	})
);
const sendVerificationEmail = vi.fn(async (_args: unknown) => ({
	data: { status: true },
	error: null,
}));

vi.mock('~/lib/auth-client', () => ({
	getSession: (options?: unknown) => getSession(options),
	acceptInvitation: (args: unknown) => acceptInvitation(args),
	sendVerificationEmail: (args: unknown) => sendVerificationEmail(args),
}));

const { default: AcceptPage } = await import('../accept.vue');

const routerPush = vi.fn();
const signOut = vi.fn(async (_options?: unknown) => {});
const calls: string[] = [];
const refetch = vi.fn(async (_options?: unknown) => {
	calls.push('refetch');
});
const claim = vi.fn(async (_args?: unknown) => {
	calls.push('claim');
	return { ok: false };
});

function mountPage() {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({
			path: '/invite/accept',
			fullPath: '/invite/accept?id=inv-1',
			query: { id: 'inv-1' },
			hash: '',
			params: {},
			meta: {},
		}),
		useRouter: () => ({ push: routerPush, replace: vi.fn() }),
		useRecipientSender: () => ({ logo: { value: null } }),
		useAuth: () => ({ signOut, refetch }),
		useBackendOperation: () => ({ run: claim }),
	});
	return mount(AcceptPage, {
		global: {
			plugins: [createTestI18n()],
			components: { UiButton },
			stubs: { WorkspaceLogo: true, UiIconBox: true },
		},
	});
}

beforeEach(() => {
	sessionUser = null;
	activeOrganizationId = null;
	getSession.mockClear();
	acceptInvitation.mockClear();
	sendVerificationEmail.mockClear();
	routerPush.mockClear();
	signOut.mockClear();
	refetch.mockClear();
	claim.mockClear();
	calls.length = 0;
});

describe('accepting an invitation with a new account', () => {
	it('asks an unverified account to confirm its email instead of trying to accept', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: false };
		const wrapper = mountPage();
		await flushPromises();

		expect(acceptInvitation).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('Confirm your email');
		expect(wrapper.text()).toContain('new@owlat.example');
		expect(wrapper.text()).not.toContain('Invitation error');
	});

	it('reads the session past the cookie cache, so a just-confirmed email counts', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: true };
		mountPage();
		await flushPromises();

		expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
		expect(acceptInvitation).toHaveBeenCalledWith({ invitationId: 'inv-1' });
	});

	it('sends the confirmation again with a link back to this invitation', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: false };
		const wrapper = mountPage();
		await flushPromises();

		const resend = wrapper.findAll('button').find((b) => b.text().includes('Send the email again'));
		expect(resend).toBeDefined();
		await resend!.trigger('click');
		await flushPromises();

		expect(sendVerificationEmail).toHaveBeenCalledWith({
			email: 'new@owlat.example',
			callbackURL: '/invite/accept?id=inv-1',
		});
		expect(wrapper.text()).toContain('sent another link');
	});

	it('accepts once the email is confirmed and the person checks again', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: false };
		const wrapper = mountPage();
		await flushPromises();

		sessionUser = { email: 'new@owlat.example', emailVerified: true };
		const check = wrapper.findAll('button').find((b) => b.text().includes("I've confirmed it"));
		await check!.trigger('click');
		await flushPromises();

		expect(acceptInvitation).toHaveBeenCalledWith({ invitationId: 'inv-1' });
		expect(wrapper.text()).toContain('Welcome to the team!');
	});

	it('refreshes the session into the joined workspace before claiming its mailbox', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: true };
		acceptInvitation.mockResolvedValueOnce({
			data: { member: { organizationId: 'org-1' }, invitation: { organizationId: 'org-1' } },
			error: null,
		});
		mountPage();
		await flushPromises();

		// The token from before joining names no workspace, so a claim sent with
		// it is refused with "No active organization".
		expect(refetch).toHaveBeenCalledWith({
			force: true,
			expected: 'authenticated',
			activeOrganizationId: 'org-1',
		});
		expect(calls[0]).toBe('refetch');
		expect(calls).toContain('claim');
	});

	it('carries on when the invitation was already accepted from the confirmation tab', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: false };
		const wrapper = mountPage();
		await flushPromises();

		// The confirmation link opened this invitation in another tab, which
		// accepted it and made the workspace active on the shared session.
		sessionUser = { email: 'new@owlat.example', emailVerified: true };
		activeOrganizationId = 'org-1';
		acceptInvitation.mockResolvedValueOnce({
			data: null,
			error: { code: 'INVITATION_NOT_FOUND', message: 'Invitation not found', status: 400 },
		});
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
		await flushPromises();

		expect(wrapper.text()).not.toContain('Invitation error');
		expect(routerPush).toHaveBeenCalledWith('/welcome');
	});

	it('treats the server refusing an unverified address as the confirm step, not a dead end', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: true };
		acceptInvitation.mockResolvedValueOnce({
			data: null,
			error: {
				code: 'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION',
				message: 'Email verification required before accepting or rejecting invitation',
				status: 403,
			},
		});
		const wrapper = mountPage();
		await flushPromises();

		expect(wrapper.text()).toContain('Confirm your email');
		expect(wrapper.text()).not.toContain('Invitation error');
	});

	it('lets someone signed in to the wrong account switch to another one', async () => {
		sessionUser = { email: 'other@owlat.example', emailVerified: false };
		const wrapper = mountPage();
		await flushPromises();

		const other = wrapper
			.findAll('button')
			.find((b) => b.text().includes('Use a different account'));
		await other!.trigger('click');
		await flushPromises();

		expect(signOut).toHaveBeenCalledWith({
			redirectTo: `/auth/login?redirect=${encodeURIComponent('/invite/accept?id=inv-1')}`,
		});
	});

	it('explains an expired invitation in its own words and offers another account', async () => {
		sessionUser = { email: 'new@owlat.example', emailVerified: true };
		acceptInvitation.mockResolvedValueOnce({
			data: null,
			error: { code: 'INVITATION_NOT_FOUND', message: 'Invitation not found', status: 400 },
		});
		const wrapper = mountPage();
		await flushPromises();

		expect(wrapper.text()).toContain('This invitation has expired or was already used.');
		expect(wrapper.text()).not.toContain('Invitation not found');
		expect(wrapper.text()).not.toContain('Go to dashboard');
		expect(
			wrapper.findAll('button').some((b) => b.text().includes('Use a different account'))
		).toBe(true);
	});
});
