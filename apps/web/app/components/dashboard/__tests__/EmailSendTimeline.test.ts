/**
 * The data variables card of a transactional send: the values only for a
 * viewer the backend gave them to, the names always, and what happened to the
 * values otherwise (hidden from this role, or removed after retention).
 *
 * The error card of a send that did not arrive: a sentence first, the fix page
 * for an admin, and the provider's text and code behind a click.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import EmailSendTimeline from '../EmailSendTimeline.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

let isAdmin = true;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useCopyToClipboard: () => ({ copy: async () => undefined, copiedKey: ref(null) }),
		usePermissions: () => ({ isAdmin: ref(isAdmin) }),
	});
});

function mountTimeline(props: Record<string, unknown>) {
	return mount(EmailSendTimeline, {
		props: { status: 'delivered', sentAt: 1, deliveredAt: 2, ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiButton: true,
				NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
			},
		},
	});
}

describe('EmailSendTimeline data variables', () => {
	it('shows the names and no values to a viewer the values are hidden from', () => {
		const w = mountTimeline({
			dataVariableNames: ['firstName', 'resetUrl'],
			dataVariablesAccess: 'hidden',
		});

		expect(w.findAll('li').map((li) => li.text())).toEqual(['firstName', 'resetUrl']);
		expect(w.find('[data-testid="data-variables-note"]').text()).toContain(
			'Only owners and admins'
		);
		expect(w.find('pre').exists()).toBe(false);
		w.unmount();
	});

	it('says the values were removed once retention ended', () => {
		const w = mountTimeline({ dataVariableNames: ['resetUrl'], dataVariablesAccess: 'redacted' });

		expect(w.findAll('li').map((li) => li.text())).toEqual(['resetUrl']);
		expect(w.find('[data-testid="data-variables-note"]').text()).toContain('removed');
		w.unmount();
	});

	it('shows the values to a viewer who may see them, with when they are removed', async () => {
		const w = mountTimeline({
			dataVariables: { resetUrl: 'https://example.com/reset?token=t' },
			dataVariableNames: ['resetUrl'],
			dataVariablesAccess: 'visible',
			dataVariablesRemovedAfter: Date.UTC(2026, 10, 2, 9, 0, 0),
		});

		expect(w.find('[data-testid="data-variables-note"]').text()).toContain('removed after');
		await w.find('button[aria-expanded]').trigger('click');
		expect(w.find('pre').text()).toContain('token=t');
		w.unmount();
	});
});

describe('EmailSendTimeline error details', () => {
	const errorCard = (w: ReturnType<typeof mountTimeline>) =>
		w.find('[data-testid="send-failure-reason"]');

	it('explains a credentials failure and links to the transport page', async () => {
		isAdmin = true;
		const w = mountTimeline({
			status: 'failed',
			errorCode: 'AUTH_FAILED',
			errorMessage: '535 5.7.8 Username and Password not accepted',
		});

		const card = errorCard(w);
		expect(card.text()).toContain("refused Owlat's sending credentials");
		expect(card.text()).not.toContain('AUTH_FAILED');
		expect(card.text()).not.toContain('Username and Password');
		expect(card.find('[data-testid="send-failure-fix"]').attributes('data-to')).toBe(
			'/dashboard/admin/delivery/transport'
		);

		await card.find('button[aria-expanded]').trigger('click');
		expect(card.find('[data-testid="send-failure-provider-text"]').text()).toContain(
			'Username and Password not accepted'
		);
		expect(card.text()).toContain('Code: AUTH_FAILED');
		w.unmount();
	});

	it('tells a member to ask an admin instead of linking to an admin page', () => {
		isAdmin = false;
		const w = mountTimeline({ status: 'failed', errorCode: 'AUTH_FAILED' });
		expect(errorCard(w).find('a').exists()).toBe(false);
		expect(errorCard(w).text()).toContain('Ask an admin');
		isAdmin = true;
		w.unmount();
	});

	it('shows the provider text right away for a code it does not know', () => {
		const w = mountTimeline({
			status: 'failed',
			errorCode: 'X_PROVIDER_QUOTA',
			errorMessage: 'Daily sending quota exceeded',
		});
		const card = errorCard(w);
		expect(card.text()).toContain('a reason Owlat does not recognize');
		expect(card.find('[data-testid="send-failure-provider-text"]').text()).toContain(
			'Daily sending quota exceeded'
		);
		expect(card.text()).toContain('Code: X_PROVIDER_QUOTA');
		w.unmount();
	});

	it('says a soft bounce is handled without asking for anything', () => {
		const w = mountTimeline({
			status: 'bounced',
			bounceType: 'soft',
			bouncedAt: 3,
			errorMessage: '452 4.2.2 Mailbox full',
		});
		const card = errorCard(w);
		expect(card.text()).toContain('Owlat pauses it on its own');
		expect(card.find('a').exists()).toBe(false);
		w.unmount();
	});
});
