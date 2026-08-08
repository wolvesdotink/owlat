/**
 * THE GUARD'S PREDICATE AGAINST THE ENDPOINT'S.
 *
 * `POST /api/delivery/apply-transport` demands the typed phrase when the
 * RESULTING `EMAIL_PROVIDER` is `mta` or nothing at all. The guard decides
 * whether the browser opens the consequence dialog before sending anything, and
 * the two predicates live a package apart — so this suite pins both arms of the
 * server's rule, in both spellings of "nothing at all": the empty env value the
 * endpoint reads, and the `none` choice the screens hold, which becomes it.
 * A guard that answered `false` where the endpoint refuses would show the
 * operator a raw refusal instead of the dialog that collects the phrase.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { IndependenceSummary } from '~/utils/deliverabilityRamp';
import { independenceSummary } from '~/components/delivery/__tests__/rampFixtures';
import { buildProviderEnv, type EmailStepDraft, type ProviderChoice } from '../useSetupWizard';
import { useRelayRemovalGuard } from '../useRelayRemovalGuard';

const summary: Ref<IndependenceSummary | undefined> = ref(independenceSummary());

beforeEach(() => {
	summary.value = independenceSummary();
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: summary,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
});

function guardFor(provider: string) {
	return useRelayRemovalGuard(ref(provider));
}

/** A draft that sends on nothing, as the wizard's receive-only choice builds it. */
function receiveOnlyDraft(provider: ProviderChoice): EmailStepDraft {
	return {
		provider,
		requiresProvider: false,
		resendKey: '',
		ses: { region: '', accessKeyId: '', secretAccessKey: '' },
		smtp: { preset: 'custom', host: '', port: '', secure: false, username: '', password: '' },
		fromEmail: '',
		fromName: '',
	};
}

describe('removesReferenceArm', () => {
	it('fires for the built-in MTA while cells still lean on the relay', () => {
		expect(guardFor('mta').removesReferenceArm.value).toBe(true);
	});

	it('fires for a draft that would leave no provider at all', () => {
		expect(guardFor('').removesReferenceArm.value).toBe(true);
		expect(guardFor('  ').removesReferenceArm.value).toBe(true);
	});

	/**
	 * The screens hold a `ProviderChoice`, and its word for "no provider" is
	 * `none` — `buildProviderEnv` omits `EMAIL_PROVIDER` for it, which reaches the
	 * endpoint as the empty value gated above. A guard that only knew the env
	 * spelling would stay quiet on the one draft the server refuses.
	 */
	it('fires for the ProviderChoice spelling of no provider', () => {
		const choice: ProviderChoice = 'none';
		// The endpoint gates on the resulting VALUE, and this choice produces the
		// empty one — so the two spellings are one case, not two.
		expect(
			buildProviderEnv({ EMAIL_PROVIDER: 'resend' }, receiveOnlyDraft(choice))['EMAIL_PROVIDER']
		).toBeUndefined();

		expect(guardFor(choice).removesReferenceArm.value).toBe(true);
	});

	it('stays quiet when one relay replaces another', () => {
		expect(guardFor('resend').removesReferenceArm.value).toBe(false);
	});

	it('stays quiet once every cell has graduated', () => {
		summary.value = independenceSummary({ relayRemoval: { kind: 'safe' } });

		expect(guardFor('mta').removesReferenceArm.value).toBe(false);
		expect(guardFor('').removesReferenceArm.value).toBe(false);
	});

	it('stays quiet on a deployment that never had a relay', () => {
		summary.value = independenceSummary({
			referenceTransportId: null,
			isRelayConfigured: false,
			relayRemoval: { kind: 'safe' },
		});

		expect(guardFor('mta').removesReferenceArm.value).toBe(false);
	});

	/**
	 * The #513 shape: a relay configured through `EMAIL_PROVIDER` alone has no
	 * transport id, and the guard used to read the missing id as "no relay" and
	 * stay quiet — the operator only met the server's raw refusal. `unsafe` is
	 * the fact that matters, and it already implies the relay exists.
	 */
	it('fires on an env-configured relay whose transport id is unknown', () => {
		summary.value = independenceSummary({ referenceTransportId: null });

		expect(guardFor('mta').removesReferenceArm.value).toBe(true);
	});
});
