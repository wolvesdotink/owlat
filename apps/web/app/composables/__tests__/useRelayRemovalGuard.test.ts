/**
 * THE GUARD'S PREDICATE AGAINST THE ENDPOINT'S.
 *
 * `POST /api/delivery/apply-transport` demands the typed phrase when the
 * RESULTING `EMAIL_PROVIDER` is `mta` or nothing at all. The guard decides
 * whether the browser opens the consequence dialog before sending anything, and
 * the two predicates live a package apart — so this suite pins both arms of the
 * server's rule, including the empty one no shipped screen can produce today.
 * A guard that answered `false` where the endpoint refuses would show the
 * operator a raw refusal instead of the dialog that collects the phrase.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { IndependenceSummary } from '~/utils/deliverabilityRamp';
import { independenceSummary } from '~/components/delivery/__tests__/rampFixtures';
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

describe('removesReferenceArm', () => {
	it('fires for the built-in MTA while cells still lean on the relay', () => {
		expect(guardFor('mta').removesReferenceArm.value).toBe(true);
	});

	it('fires for a draft that would leave no provider at all', () => {
		expect(guardFor('').removesReferenceArm.value).toBe(true);
		expect(guardFor('  ').removesReferenceArm.value).toBe(true);
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
		summary.value = independenceSummary({ referenceTransportId: null });

		expect(guardFor('mta').removesReferenceArm.value).toBe(false);
	});
});
