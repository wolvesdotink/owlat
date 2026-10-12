/**
 * The AI routing policy panel's state (ADR-0073, SPEC §3, U2): the admin read
 * (`aiRouting.policy.get`), the form, and the save.
 *
 * The rules are in `utils/aiRoutingPolicy.ts`; this file wires them. Two
 * things are its own:
 *
 *  - the form follows the stored policy while it is clean, and keeps the
 *    admin's edits when another admin saves meanwhile. The save is
 *    compare-and-set on `policyVersion`, so that case comes back as a
 *    `conflict`, which is shown inline and reloads the newer policy;
 *  - a save sends only the fields changed since the form opened, against the
 *    version it opened at. The server validates again and
 *    writes the audit row, so this file never decides what is allowed.
 */
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { api } from '@owlat/api';
import type { ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import {
	draftShadowAllowanceUsd,
	isAnyShadowed,
	routingPolicyFormOf,
	routingPolicyFormProblems,
	routingPolicyUpdateArgs,
	type RoutingPolicyForm,
} from '~/utils/aiRoutingPolicy';

export function useAiRoutingPolicy() {
	const { t } = useI18n();
	const { showToast } = useToast();

	const { data, isLoading, error, refetch } = useOrganizationQuery(api.aiRouting.policy.get);

	/** Set when a save met a newer policy; cleared by the next edit or save. */
	const isConflict = ref(false);
	const { run: runUpdate, isLoading: isSaving } = useBackendOperation(api.aiRouting.policy.update, {
		label: () => t('dashboard.admin.instance.aiProvider.routing.saveOperation'),
		onError: (op) => {
			if (op.category !== 'conflict') return false;
			isConflict.value = true;
			return true;
		},
	});

	const stored = computed<ResolvedRoutingPolicy | null>(() => data.value?.policy ?? null);
	const dailyCeilingUsd = computed(() => data.value?.dailyCeilingUsd ?? 0);

	const form = reactive<RoutingPolicyForm>({
		switches: {} as RoutingPolicyForm['switches'],
		knowledgeEntryCap: '',
		verifyClaimCap: '',
		isInterpretationCached: false,
		triagePercent: '',
		shadowMessagePercent: '',
		shadowCeilingPercent: '',
		shadowCapUsd: '',
	});
	const isDirty = ref(false);
	let hydrating = false;
	/**
	 * The policy the form was opened from. A save diffs against it and expects
	 * its version, never the latest subscription value: diffing a stale form
	 * against a newer policy would send its old values as changes and revert
	 * what another admin just saved. With this, that save meets a conflict.
	 */
	const base = shallowRef<ResolvedRoutingPolicy | null>(null);

	function hydrate(policy: ResolvedRoutingPolicy) {
		base.value = policy;
		hydrating = true;
		Object.assign(form, routingPolicyFormOf(policy));
		hydrating = false;
		isDirty.value = false;
	}

	// The stored policy, while the admin has nothing unsaved over it.
	watch(
		stored,
		(policy) => {
			if (policy && !isDirty.value) hydrate(policy);
		},
		{ immediate: true }
	);
	watch(
		form,
		() => {
			if (hydrating) return;
			isDirty.value = true;
			isConflict.value = false;
		},
		{ deep: true, flush: 'sync' }
	);

	const problems = computed(() =>
		routingPolicyFormProblems(form, { dailyCeilingUsd: dailyCeilingUsd.value })
	);
	const hasProblems = computed(() => Object.keys(problems.value).length > 0);
	const isShadowing = computed(() => isAnyShadowed(form));
	/** What shadow runs could spend a day under the form as it stands. */
	const shadowAllowance = computed(() =>
		base.value ? draftShadowAllowanceUsd(form, base.value, dailyCeilingUsd.value) : 0
	);

	/** Save the changed fields. Resolves `true` when nothing is left unsaved. */
	async function save(): Promise<boolean> {
		const policy = base.value;
		if (!policy || hasProblems.value) return false;
		const args = routingPolicyUpdateArgs(form, policy);
		if (!args) {
			isDirty.value = false;
			return true;
		}
		isConflict.value = false;
		const result = await runUpdate(args);
		if (!result.ok) {
			// Another admin saved first: show theirs, and say so.
			if (isConflict.value && stored.value) hydrate(stored.value);
			return false;
		}
		hydrate(result.result);
		showToast(t('dashboard.admin.instance.aiProvider.routing.saved'));
		return true;
	}

	/** Back to the stored policy, dropping unsaved edits. */
	function discard() {
		if (stored.value) hydrate(stored.value);
		isConflict.value = false;
	}

	return {
		data,
		isLoading,
		error,
		refetch,
		stored,
		dailyCeilingUsd,
		form,
		isDirty,
		isSaving,
		isConflict,
		problems,
		hasProblems,
		isShadowing,
		shadowAllowance,
		save,
		discard,
	};
}
