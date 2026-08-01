// @vitest-environment happy-dom
/**
 * THE TRANSPORT EDITOR'S ONE DANGEROUS CHANGE.
 *
 * Rotating a credential or moving between two relays keeps a second arm.
 * Switching to the built-in MTA DISCONNECTS the relay, and every cell the ramp
 * has not graduated is still sending part of its mail through it — that traffic
 * does not move gently, it all moves at once. The Independence screen already
 * names that consequence; this suite pins that the screen where the change
 * ACTUALLY HAPPENS names it too, rather than leaving the dialog as a decoration
 * an operator can walk around.
 *
 * The assertion that carries the weight is the negative one: no request leaves
 * the browser until the phrase is typed. (The endpoint re-checks it anyway —
 * `server/api/delivery/__tests__/apply-transport-relay-removal.test.ts` — which
 * is what makes the rule a rule rather than a habit of this component.)
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { RELAY_REMOVAL_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import TransportEditor from '../TransportEditor.vue';
import RampConfirmDialog from '../RampConfirmDialog.vue';
import { independenceSummary } from './rampFixtures';
import type { IndependenceSummary } from '~/utils/deliverabilityRamp';
import { wizardStubs } from './wizardHarness';

const summary: Ref<IndependenceSummary | undefined> = ref(independenceSummary());
const fetchMock = vi.fn();

beforeEach(() => {
	summary.value = independenceSummary();
	fetchMock.mockReset().mockResolvedValue({
		ok: true,
		applied: true,
		requiresRestart: false,
		message: 'Sending now uses the new transport.',
	});
	vi.stubGlobal('$fetch', fetchMock);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: summary,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
});

function mountEditor(currentProvider = 'ses') {
	return mount(TransportEditor, {
		props: { currentProvider },
		global: {
			stubs: wizardStubs,
			components: { DeliveryRampConfirmDialog: RampConfirmDialog },
		},
		attachTo: document.body,
	});
}

async function beginEditing(wrapper: ReturnType<typeof mountEditor>): Promise<void> {
	const edit = wrapper.findAll('button').find((node) => node.text().includes('Edit transport'));
	if (edit === undefined) throw new Error('The editor never offered its edit affordance');
	await edit.trigger('click');
}

function applyButton(wrapper: ReturnType<typeof mountEditor>) {
	const button = wrapper.findAll('button').find((node) => node.text().includes('Apply transport'));
	if (button === undefined) throw new Error('The editor never rendered its apply button');
	return button;
}

async function chooseOwnMta(wrapper: ReturnType<typeof mountEditor>): Promise<void> {
	await wrapper.find('input[type="radio"][value="mta"]').setValue();
}

describe('the transport editor’s relay-removal confirmation', () => {
	it('sends nothing when the apply would disconnect a relay cells still lean on', async () => {
		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');

		expect(fetchMock).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="transport-removal-consequence"]').text()).toContain(
			'immediately — not gradually'
		);
		expect(
			wrapper.find('[data-testid="ramp-confirm-submit"]').attributes('disabled')
		).toBeDefined();
		wrapper.unmount();
	});

	it('applies with the typed phrase once the consequence is confirmed', async () => {
		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');

		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue(RELAY_REMOVAL_CONFIRMATION);
		await wrapper.find('[data-testid="ramp-confirm-submit"]').trigger('click');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
		expect(url).toBe('/api/delivery/apply-transport');
		expect(options.body['relayRemovalConfirmation']).toBe(RELAY_REMOVAL_CONFIRMATION);
		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('does not stand in the way when every cell has graduated', async () => {
		summary.value = independenceSummary({ relayRemoval: { kind: 'safe' } });
		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');

		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, options] = fetchMock.mock.calls[0] as [string, { body: Record<string, unknown> }];
		expect(options.body['relayRemovalConfirmation']).toBeUndefined();
		wrapper.unmount();
	});

	it('applies the built-in MTA without the setup wizard’s identity fields', async () => {
		// `validateEmailStep` demands the sending IPs and the EHLO hostname when the
		// MTA is chosen, because the SETUP wizard collects them on that step. This
		// editor neither renders nor writes them — they are not transport env keys —
		// so gating Apply on them made the whole removal path unreachable: the
		// button did nothing, silently.
		summary.value = independenceSummary({ relayRemoval: { kind: 'safe' } });
		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');

		const [, options] = fetchMock.mock.calls[0] as [
			string,
			{ body: { providerEnv: Record<string, string> } },
		];
		expect(options.body.providerEnv['EMAIL_PROVIDER']).toBe('mta');
		expect(options.body.providerEnv['MTA_TRANSACTIONAL_IPS']).toBeUndefined();
		wrapper.unmount();
	});

	it('does not stand in the way of a credential rotation that keeps the relay', async () => {
		const wrapper = mountEditor('resend');
		await beginEditing(wrapper);
		await wrapper.find('input[type="radio"][value="resend"]').setValue();
		await wrapper.find('#field-resend-api-key').setValue('re_live_abc');
		await applyButton(wrapper).trigger('click');

		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('sends nothing on a standalone deployment either — there is no relay to pull', async () => {
		summary.value = independenceSummary({
			referenceTransportId: null,
			relayRemoval: { kind: 'safe' },
		});
		const wrapper = mountEditor('mta');
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');

		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});
