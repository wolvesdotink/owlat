import { api } from '@owlat/api';

/**
 * Run-once live verification of this deployment's published MTA-STS policy.
 *
 * `domain()` returns the sending domain to verify against, or `null` when the
 * verify shouldn't run yet (no policy published, a non-admin viewer, or no
 * domain known). The verify action fires exactly ONCE — the first time `domain()`
 * yields a non-null value — matching the run-once semantics both the delivery
 * readiness panel and the receiving-DNS section need. It is admin-gated and
 * fail-soft on the backend (never throws), so `verification` stays `undefined`
 * until it resolves and callers simply omit the status line rather than erroring.
 *
 * Returns `{ verification, checked }`: the structured verdict (or `undefined`
 * before it runs / on a fault) and whether the single check has completed.
 */
export function useMtaStsVerification(domain: () => string | null) {
	const { run } = useBackendOperation(api.domains.mtaStsVerify.verifyReceivingMtaSts, {
		label: 'Verify MTA-STS publication',
		type: 'action',
	});
	type MtaStsVerdict = Awaited<ReturnType<typeof run>>;
	const verification = ref<MtaStsVerdict>(undefined);
	const checked = ref(false);
	const ran = ref(false);
	watch(
		domain,
		async (target) => {
			if (target === null || ran.value) return;
			ran.value = true;
			verification.value = await run({ domain: target });
			checked.value = true;
		},
		{ immediate: true }
	);
	return { verification, checked };
}
