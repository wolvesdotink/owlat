/**
 * "Send test alert": a line per channel with what happened, the webhook line
 * following its delivery rows until they settle, and the in-app channel shown
 * as a toast on this page. The failure and skip states are pinned here; the
 * demo stack has no push keys, no transport and no subscribed webhook.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import DeliverabilityAlertTestPanel from '../DeliverabilityAlertTestPanel.vue';

const run = vi.fn();
const showToast = vi.fn();
const webhookOutcome = ref<{ delivered: number; failed: number; pending: number } | undefined>();
let queryArgs: () => unknown = () => 'skip';
let operationOptions: { type?: string } | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	webhookOutcome.value = undefined;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useBackendOperation', (_operation: unknown, options: { type?: string }) => {
		operationOptions = options;
		return { run };
	});
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		queryArgs = args;
		return { data: webhookOutcome };
	});
});

function mountPanel() {
	return mount(DeliverabilityAlertTestPanel, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiButton: {
					props: ['loading'],
					emits: ['click'],
					template: '<button @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

async function send(result: unknown) {
	run.mockResolvedValueOnce({ ok: true, result });
	const wrapper = mountPanel();
	await wrapper.get('[data-testid="alert-test-send"]').trigger('click');
	await flushPromises();
	return wrapper;
}

const line = (wrapper: ReturnType<typeof mountPanel>, key: string) =>
	wrapper.get(`[data-testid="alert-test-${key}"]`).text();

describe('DeliverabilityAlertTestPanel', () => {
	it('shows nothing until a test ran', () => {
		expect(mountPanel().find('[data-testid="alert-test-result"]').exists()).toBe(false);
	});

	it('runs the test as an action, which Convex refuses to run as a mutation', () => {
		mountPanel();
		expect(operationOptions?.type).toBe('action');
	});

	it('reports every channel, and follows the webhook until it is delivered', async () => {
		const wrapper = await send({
			email: { status: 'accepted', to: 'admin@example.com' },
			inApp: { isSwitchOn: true },
			push: { status: 'sent', delivered: 2, failed: 0 },
			webhook: { status: 'queued', logIds: ['log-1'] },
		});
		expectFullyLocalized(wrapper);
		expect(line(wrapper, 'email')).toBe('Accepted for admin@example.com');
		expect(line(wrapper, 'inApp')).toBe('Shown here');
		expect(line(wrapper, 'push')).toBe('Delivered to 2 devices');
		expect(line(wrapper, 'webhook')).toBe('Sending to 1 endpoint');
		expect(queryArgs()).toEqual({ logIds: ['log-1'] });
		expect(showToast).toHaveBeenCalledWith(
			'Test deliverability alert: a real alert would show here.',
			'warning'
		);

		webhookOutcome.value = { delivered: 1, failed: 0, pending: 0 };
		await flushPromises();
		expect(line(wrapper, 'webhook')).toBe('Delivered to 1 endpoint');
		webhookOutcome.value = { delivered: 0, failed: 1, pending: 0 };
		await flushPromises();
		expect(line(wrapper, 'webhook')).toContain('Failed on 1 endpoint');
	});

	it('says why a channel did not carry the test', async () => {
		const wrapper = await send({
			email: { status: 'failed', error: 'Connection refused' },
			inApp: { isSwitchOn: false },
			push: { status: 'skipped', reason: 'no_device' },
			webhook: { status: 'skipped', reason: 'not_set' },
		});
		expectFullyLocalized(wrapper);
		expect(line(wrapper, 'email')).toBe('Not sent: Connection refused');
		expect(line(wrapper, 'inApp')).toContain('Off for you');
		expect(line(wrapper, 'push')).toBe('None of your devices has push turned on');
		expect(line(wrapper, 'webhook')).toBe('No webhook is subscribed to deliverability alerts');
		expect(queryArgs()).toBe('skip');
		expect(showToast).not.toHaveBeenCalled();
	});
});
