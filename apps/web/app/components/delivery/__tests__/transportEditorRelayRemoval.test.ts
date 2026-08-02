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
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { RELAY_REMOVAL_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import TransportEditor from '../TransportEditor.vue';
import RampConfirmDialog from '../RampConfirmDialog.vue';
import { independenceSummary } from './rampFixtures';
import type { IndependenceSummary } from '~/utils/deliverabilityRamp';
import { wizardStubs } from './wizardHarness';

const summary: Ref<IndependenceSummary | undefined> = ref(independenceSummary());
const summaryError: Ref<Error | null> = ref(null);
const fetchMock = vi.fn();

beforeEach(() => {
	summary.value = independenceSummary();
	summaryError.value = null;
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
		error: summaryError,
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

	it('asks for nothing on a standalone deployment — there is no relay to pull', async () => {
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

/**
 * THE PATH WHERE THIS SCREEN KNOWS NOTHING.
 *
 * The dialog is opened by THIS component's own removal read, and that read can
 * fault — or simply not have resolved when Apply is pressed. Either way the
 * endpoint refuses fail-closed and asks for the phrase, and a refusal rendered
 * under "Couldn't apply" left an operator reading "type REMOVE THE RELAY" on a
 * screen with no phrase input anywhere on it. The refusal is a request, so it
 * opens the dialog.
 */
describe('the transport editor when its own removal read did not answer', () => {
	/**
	 * The endpoint's fail-closed refusal, in the shape the route returns it: the
	 * consequence on its own, plus a `message` that closes with the instruction
	 * for a caller reading the response with no dialog around it.
	 */
	function refusedPendingConfirmation() {
		const consequence =
			'Which cells are still leaning on the relay could not be established, so this cannot be ' +
			'treated as safe. Disconnecting it moves whatever they still send onto your own server ' +
			'immediately — not gradually.';
		return {
			ok: false,
			applied: false,
			requiresRestart: false,
			needsRelayRemovalConfirmation: true,
			relayRemovalConsequence: consequence,
			message: `${consequence} Type “${RELAY_REMOVAL_CONFIRMATION}” to disconnect it anyway.`,
		};
	}

	it('opens the dialog on the refusal instead of printing the rule', async () => {
		summary.value = undefined;
		summaryError.value = new Error('independence read unavailable');
		fetchMock.mockResolvedValueOnce(refusedPendingConfirmation());

		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');
		await flushPromises();

		// The request WAS made — this screen had no basis to hold it back.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Couldn’t apply');
		expect(wrapper.text()).not.toContain("Couldn't apply");
		// And with nothing read, the consequence may not claim zero cells.
		const consequence = wrapper.find('[data-testid="transport-removal-consequence"]').text();
		expect(consequence).toContain('could not be established');
		expect(consequence).not.toContain('0 cell');

		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue(RELAY_REMOVAL_CONFIRMATION);
		await wrapper.find('[data-testid="ramp-confirm-submit"]').trigger('click');
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [, options] = fetchMock.mock.calls[1] as [string, { body: Record<string, unknown> }];
		expect(options.body['relayRemovalConfirmation']).toBe(RELAY_REMOVAL_CONFIRMATION);
		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('opens it on the plain race too — Apply pressed before the read resolves', async () => {
		summary.value = undefined;
		fetchMock.mockResolvedValueOnce(refusedPendingConfirmation());

		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(true);
		wrapper.unmount();
	});

	/**
	 * The refusal's own read answered even though this browser's did not, and its
	 * message carries the cell count and the projected safe date. Rendering the
	 * local guard's figure-free sentence instead throws away the most actionable
	 * fact the feature produces, on the one action that cannot be undone.
	 */
	function refusedWithFigures() {
		const consequence =
			'4 cells have not graduated yet and still send part of their mail through resend. ' +
			'Disconnecting it moves all of that traffic onto your own server immediately — not ' +
			'gradually — and the reputation resend has built for your domain stops being available ' +
			'to fall back on. On the current pace, waiting until about 14 Aug 2026 would avoid that ' +
			'entirely.';
		return {
			...refusedPendingConfirmation(),
			relayRemovalConsequence: consequence,
			message: `${consequence} Type “${RELAY_REMOVAL_CONFIRMATION}” to disconnect it anyway.`,
		};
	}

	it('shows the server’s cell count and safe date when only the server’s read answered', async () => {
		summary.value = undefined;
		summaryError.value = new Error('independence read unavailable');
		fetchMock.mockResolvedValueOnce(refusedWithFigures());

		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');
		await flushPromises();

		const consequence = wrapper.find('[data-testid="transport-removal-consequence"]').text();
		expect(consequence).toContain('4 cells have not graduated yet');
		expect(consequence).toContain('14 Aug 2026');
		expect(consequence).not.toContain('could not be established');
		// AND IT DOES NOT REPEAT THE DIALOG'S OWN INSTRUCTION. The refusal's
		// `message` closes with "type REMOVE THE RELAY to disconnect it anyway",
		// which the input's label states three lines below — so the dialog renders
		// the consequence field, and the phrase appears once, where it is typed.
		expect(consequence).not.toContain('to disconnect it anyway');
		expect(consequence).not.toContain(RELAY_REMOVAL_CONFIRMATION);
		const labels = wrapper.findAll('label').map((node) => node.text().replace(/\s+/g, ' '));
		expect(labels).toContain(`Type ${RELAY_REMOVAL_CONFIRMATION} to confirm`);
		wrapper.unmount();
	});

	// The other way the local copy has no figures: it answered `safe` a moment
	// before the endpoint's independent read found cells still leaning on the
	// relay. "Read answered" is not the same question as "read has something to
	// say", and only the second one may pick the sentence.
	it('prefers the server’s figures over a local read that came back safe', async () => {
		summary.value = independenceSummary({ relayRemoval: { kind: 'safe' } });
		fetchMock.mockResolvedValueOnce(refusedWithFigures());

		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="transport-removal-consequence"]').text()).toContain(
			'4 cells have not graduated yet'
		);
		wrapper.unmount();
	});

	// The live query is the better source WHEN IT HAS ONE: it re-renders as the
	// read advances, and a string captured off one response cannot.
	it('keeps its own live copy when its read found the cells itself', async () => {
		fetchMock.mockResolvedValueOnce(refusedWithFigures());

		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');
		// The local read said "unsafe", so the dialog opened WITHOUT a request; the
		// phrase then draws the refusal out of the mocked endpoint.
		await wrapper.find('[data-testid="ramp-confirm-input"]').setValue(RELAY_REMOVAL_CONFIRMATION);
		await wrapper.find('[data-testid="ramp-confirm-submit"]').trigger('click');
		await flushPromises();

		const consequence = wrapper.find('[data-testid="transport-removal-consequence"]').text();
		expect(consequence).toContain('1 cell has not graduated yet');
		expect(consequence).not.toContain('4 cells have not graduated yet');
		wrapper.unmount();
	});

	it('still reports a refusal that no phrase can clear as an error', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: false,
			applied: false,
			requiresRestart: false,
			message: 'Could not update the delivery provider on the backend: connection refused.',
		});
		summary.value = independenceSummary({ relayRemoval: { kind: 'safe' } });

		const wrapper = mountEditor();
		await beginEditing(wrapper);
		await chooseOwnMta(wrapper);
		await applyButton(wrapper).trigger('click');
		await flushPromises();

		expect(wrapper.find('[data-testid="ramp-confirm-dialog"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('connection refused');
		wrapper.unmount();
	});
});
