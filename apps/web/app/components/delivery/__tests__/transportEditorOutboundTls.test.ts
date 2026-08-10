// @vitest-environment happy-dom
/**
 * THE ONE CREDENTIAL THIS EDITOR SEEDS ITSELF.
 *
 * Every other field starts blank on purpose — secrets are never rendered back.
 * The built-in MTA's outbound-TLS FLOOR is not a secret and must not start
 * blank: it is written on every apply, so an editor that forgot the active mode
 * would quietly lower an operator's `require-verified` floor to `opportunistic`
 * the next time they rotated an unrelated credential. A security-relevant
 * downgrade, made by the screen they used to make an unrelated change.
 *
 * That seed is the one place a surface writes into the descriptor-keyed values
 * map by name, so it is also the one place a catalog rename can strand: the map
 * is keyed by `string`, the write would land on a dead key, the select would
 * fall back to the descriptor's default, and the build would stay green. This
 * suite covers the whole wire — prop in, values map, rendered control, env patch
 * out — rather than any one hop of it.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import TransportEditor from '../TransportEditor.vue';
import { independenceSummary } from './rampFixtures';
import { wizardStubs } from './wizardHarness';

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset().mockResolvedValue({
		ok: true,
		applied: true,
		requiresRestart: false,
		message: 'Sending now uses the new transport.',
	});
	vi.stubGlobal('$fetch', fetchMock);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	// A deployment with nothing leaning on a relay, so pressing Apply on the own
	// arm goes straight to the patch — the removal-confirmation dialog is
	// `transportEditorRelayRemoval.test.ts`'s subject, not this suite's.
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(independenceSummary({ relayRemoval: { kind: 'safe' } })),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
});

async function openEditor(currentOutboundTlsMode: string | null) {
	const wrapper = mount(TransportEditor, {
		props: { currentProvider: 'mta', currentOutboundTlsMode },
		// The removal dialog is stubbed out entirely: it never opens on this
		// fixture, and `transportEditorRelayRemoval.test.ts` is what mounts it for
		// real.
		global: { stubs: { ...wizardStubs, DeliveryRampConfirmDialog: true } },
		attachTo: document.body,
	});
	const edit = wrapper.findAll('button').find((node) => node.text().includes('Edit transport'));
	if (edit === undefined) throw new Error('The editor never offered its edit affordance');
	await edit.trigger('click');
	return wrapper;
}

/** The rendered floor selector — labelled by the catalog descriptor. */
function tlsSelect(wrapper: Awaited<ReturnType<typeof openEditor>>) {
	const select = wrapper.find('#field-connection-security');
	if (!select.exists()) throw new Error('The editor never rendered the connection-security field');
	return select.element as HTMLSelectElement;
}

describe('the transport editor seeds the outbound-TLS floor from the active one', () => {
	it('shows the floor the deployment is already on', async () => {
		const wrapper = await openEditor('require-verified');
		expect(tlsSelect(wrapper).value).toBe('require-verified');
	});

	it('falls back to the backend default when the mode is unset or unknown', async () => {
		expect(tlsSelect(await openEditor(null)).value).toBe('opportunistic');
		expect(tlsSelect(await openEditor('require-everything')).value).toBe('opportunistic');
	});

	it('applies the seeded floor unchanged, rather than resetting it', async () => {
		// The regression in one assertion: an operator opens the editor to change
		// something else and presses Apply. The patch must carry the floor they
		// already chose.
		const wrapper = await openEditor('require-verified');
		const apply = wrapper.findAll('button').find((node) => node.text().includes('Apply transport'));
		if (apply === undefined) throw new Error('The editor never rendered its apply button');
		await apply.trigger('click');
		await flushPromises();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]![1].body.providerEnv).toMatchObject({
			EMAIL_PROVIDER: 'mta',
			OUTBOUND_TLS_MODE: 'require-verified',
		});
	});

	it('renders this screen’s own guidance under that field, keyed by the field', async () => {
		// The per-field slot the editor fills. It is addressed by the descriptor's
		// KEY, the same key the seed above looks the variable up by — so a field
		// that moved would take both with it rather than leaving one behind.
		const wrapper = await openEditor('require-verified');
		expect(wrapper.text()).toContain('can bounce mail to receivers');
	});
});
