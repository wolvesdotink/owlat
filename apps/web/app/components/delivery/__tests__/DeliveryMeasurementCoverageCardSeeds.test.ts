// @vitest-environment happy-dom
/**
 * Retiring a deliverability seed from the delivery hub.
 *
 * The connect cap refuses the 51st seed with "disconnect one before connecting
 * another", and until this shipped nothing in the product could — so the row a
 * Disconnect button appears on, and the confirmation in front of it, are the
 * whole feature. Each row names the mailbox it acts on, because "Disconnect"
 * repeated N times is not a name.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, computed, type Ref } from 'vue';

import DeliveryMeasurementCoverageCard from '../DeliveryMeasurementCoverageCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Status = {
	seedMailboxes: {
		connected: number;
		rotationRemindersDue: number;
		accounts: Array<{
			accountId: string;
			address: string;
			provider: string;
			rotationReminderDue: boolean;
		}>;
	};
	microsoftFeedback: { configured: boolean; feedCount: number };
};

const status: Ref<Status | null> = ref(null);
const run = vi.fn(async (_args: unknown) => ({ ok: true }));
const toasts: string[] = [];

beforeAll(() => {
	vi.stubGlobal('useOrganizationQuery', () => ({ data: status, isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', () => ({
		run,
		isLoading: ref(false),
		inlineError: ref(null),
	}));
	vi.stubGlobal('useToast', () => ({
		showToast: (message: string) => {
			toasts.push(message);
		},
	}));
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	run.mockClear();
	toasts.length = 0;
	status.value = {
		seedMailboxes: {
			connected: 2,
			rotationRemindersDue: 0,
			accounts: [
				{
					accountId: 'acc_1',
					address: 'probe-one@gmail.com',
					provider: 'gmail',
					rotationReminderDue: false,
				},
				{
					accountId: 'acc_2',
					address: 'probe-two@outlook.com',
					provider: 'microsoft',
					rotationReminderDue: true,
				},
			],
		},
		microsoftFeedback: { configured: false, feedCount: 0 },
	};
});

const passthrough = (tag = 'div') => ({ template: `<${tag}><slot /></${tag}>` });
const confirmStub = {
	props: ['open', 'title', 'description', 'confirmText', 'variant', 'isLoading'],
	emits: ['confirm', 'cancel', 'update:open'],
	template: `<div v-if="open" class="dialog">
		<p class="dialog-description">{{ description }}</p>
		<button class="dialog-confirm" @click="$emit('confirm')">{{ confirmText }}</button>
		<button class="dialog-cancel" @click="$emit('cancel')">cancel</button>
	</div>`,
};

const mountCard = () =>
	mount(DeliveryMeasurementCoverageCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { props: ['name'], template: '<span />' },
				UiCard: passthrough('section'),
				UiBadge: passthrough('span'),
				UiDisclosure: { props: ['modelValue', 'label'], template: '<div><slot /></div>' },
				UiButton: {
					props: ['size', 'variant', 'disabled', 'loading'],
					template: '<button v-bind="$attrs"><slot /></button>',
				},
				UiConfirmationDialog: confirmStub,
				PostboxMailboxConnectForm: { template: '<form />' },
			},
		},
	});

describe('seed mailboxes on the delivery hub', () => {
	it('offers a disconnect per mailbox, each naming its own address', () => {
		const wrapper = mountCard();
		const buttons = wrapper.findAll('[data-testid="seed-disconnect"]');
		expect(buttons).toHaveLength(2);
		expect(buttons[0]!.attributes('aria-label')).toBe(
			'Disconnect the test mailbox probe-one@gmail.com'
		);
		expect(buttons[1]!.attributes('aria-label')).toBe(
			'Disconnect the test mailbox probe-two@outlook.com'
		);
	});

	it('disconnects the row that was clicked, and only after confirmation', async () => {
		const wrapper = mountCard();
		await wrapper.findAll('[data-testid="seed-disconnect"]')[1]!.trigger('click');
		expect(run).not.toHaveBeenCalled();
		expect(wrapper.find('.dialog-description').text()).toContain('probe-two@outlook.com');

		await wrapper.find('.dialog-confirm').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ accountId: 'acc_2' });
		expect(toasts).toEqual(['probe-two@outlook.com disconnected.']);
	});

	it('runs nothing when the confirmation is dismissed', async () => {
		const wrapper = mountCard();
		await wrapper.findAll('[data-testid="seed-disconnect"]')[0]!.trigger('click');
		await wrapper.find('.dialog-cancel').trigger('click');
		await flushPromises();
		expect(run).not.toHaveBeenCalled();
		expect(wrapper.find('.dialog').exists()).toBe(false);
	});

	it('keeps the rotation nudge separate from retiring the mailbox', async () => {
		const wrapper = mountCard();
		const rows = wrapper.findAll('[data-testid="seed-disconnect"]');
		// Only the second seed is due for rotation, and its two buttons are
		// distinct actions — acknowledging is not disconnecting.
		expect(wrapper.text()).toContain('Credentials rotated');
		expect(rows).toHaveLength(2);
	});
});
