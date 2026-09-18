<script setup lang="ts">
/**
 * Receiving guidance for a SEND-ONLY sending domain — the sibling of
 * `ReceivingDnsSection.vue`, and its exact opposite in intent.
 *
 * That section exists to hand the operator an apex MX record pointing at this
 * deployment. For a domain whose mail lives on Google Workspace or Microsoft
 * 365, publishing that record takes EVERY incoming message away from their
 * provider — and by the time they notice, the MX has propagated. So when the
 * domain is marked `receivingMode: 'external'`, this section REPLACES that one
 * and says the one thing that matters at a glance: don't change your MX.
 *
 * Everything else here is the small print behind that sentence:
 *
 *  - a LIVE apex-MX lookup, so the page reports what DNS actually says rather
 *    than what the setting claims. `pointsHere` is the loud state — the domain
 *    is marked external but its MX already resolves to this instance, i.e. the
 *    damage is done and nobody has told them. The check is admin-gated and
 *    fail-soft (same shape as the reverse-DNS preflight): a DNS hiccup resolves
 *    to "not confirmed" and never breaks the panel or blocks anything;
 *  - the bounce note, because the ONE MX Owlat does ask for lives on a
 *    return-path SUBDOMAIN of its own and never touches the apex — which is the
 *    first thing a careful operator will want to check;
 *  - the SPF note, DERIVED FROM THE STORED RECORD rather than from the declared
 *    provider. When the record already carries the provider's include it says
 *    so; when it does not — a relay-primary domain, a deployment with no
 *    `MTA_SPF_INCLUDE`, a provider we have no include for — it says who has to
 *    add what, because the difference between those two sentences is the
 *    difference between a working record and a silent SPF failure on everything
 *    they still send from their provider;
 *  - the IMAP path, because "Owlat only sends" is a fair question to follow with
 *    "then where do I read my mail?" — receiving already works over IMAP.
 *
 * Nothing in here is a "setup incomplete" nag: send-only is a fully supported
 * configuration, not a half-finished one.
 */
import { api } from '@owlat/api';
import {
	externalReceivingSpfInclude,
	externalReceivingSpfMerged,
	type ExternalReceivingProvider,
} from '@owlat/shared/externalReceiving';
import { EXTERNAL_RECEIVING_PROVIDER_KEYS } from '~/utils/externalReceivingLabels';

const props = defineProps<{
	/**
	 * The sending domain whose inbound mail stays somewhere else. Also the key the
	 * live preflight looks up — the action resolves the apex MX by NAME, because
	 * what matters is what DNS says today, not what the row was told.
	 */
	domain: string;
	/** Which provider the operator said keeps the MX. */
	provider: ExternalReceivingProvider | null | undefined;
	/**
	 * The domain's GENERATED apex SPF record, exactly as stored — the record the
	 * panel above tells the operator to publish, or `null` when there is none.
	 *
	 * The SPF copy below is derived from this value rather than from `provider`,
	 * because "we already merged your provider's include" is a claim about the
	 * record and there are three ordinary configurations where it is false: a
	 * relay-primary domain (SES/Mandrill) switched to external after
	 * registration, a domain switched while this deployment has no
	 * `MTA_SPF_INCLUDE`, and a row with no SPF record at all — where "the SPF
	 * record above" refers to nothing. Telling those operators the merge is done
	 * is what leaves their real provider unauthorized.
	 */
	spfValue: string | null;
	/**
	 * The return-path (bounce) host as the backend actually keyed it, so the
	 * bounce note names the real subdomain instead of guessing one. Null when the
	 * provider generates no MAIL FROM record.
	 */
	returnPathHost: string | null;
	/**
	 * Whether the viewer may run the admin-gated live check. A member who may not
	 * still sees the guidance — only the lookup is withheld, because it would 403.
	 */
	canManage: boolean;
}>();

const { t } = useI18n();

/** Sentence-form provider name; falls back to the neutral wording when unset. */
const providerLabel = computed(() =>
	t(EXTERNAL_RECEIVING_PROVIDER_KEYS[props.provider ?? 'other'])
);

// Live apex-MX lookup. Fail-soft by contract: the backend never throws, and a
// `run()` that faults anyway leaves the verdict undefined, so the panel simply
// omits the status line rather than erroring. The guidance above it does not
// depend on the lookup — it is true whether or not DNS answered.
const { run: runMxCheck } = useBackendOperation(
	api.domains.dnsVerification.checkExternalReceivingMx,
	{ label: () => t('components.domains.externalReceivingSection.operation'), type: 'action' }
);

type MxVerdict = BackendOperationValue<ReturnType<typeof runMxCheck>>;
const verdict = ref<MxVerdict | undefined>(undefined);
const checked = ref(false);

// A `watch` rather than `onMounted`, for the same reason the reverse-DNS
// preflight uses one: the app is `ssr: false`, so on a cold boot / deep link the
// role that decides `canManage` resolves AFTER mount, and a one-shot mount check
// would early-return and never run. The `hasRun` guard keeps it a single lookup.
const hasRun = ref(false);
watch(
	() => props.canManage,
	async (allowed) => {
		if (!allowed || hasRun.value) return;
		hasRun.value = true;
		const result = await runMxCheck({ domain: props.domain });
		verdict.value = result.ok ? result.result : undefined;
		checked.value = true;
	},
	{ immediate: true }
);

/** The MX hosts DNS actually answered with, as one readable list. */
const mxHosts = computed(() => (verdict.value?.hosts ?? []).join(', '));

// The four verdicts, in the order they matter. `pointsHere` outranks everything:
// it is the only one that means mail is being lost right now.
const pointsHere = computed(() => checked.value && verdict.value?.pointsHere === true);
const noMx = computed(
	() =>
		checked.value &&
		verdict.value !== undefined &&
		!verdict.value.pointsHere &&
		!verdict.value.hasMx
);
/** DNS agrees with the setting — the calm, confirmed state. */
const confirmed = computed(
	() =>
		checked.value &&
		verdict.value !== undefined &&
		verdict.value.hasMx &&
		!verdict.value.pointsHere &&
		verdict.value.provider !== null &&
		verdict.value.provider === (props.provider ?? null)
);
/**
 * Mail is delivered somewhere that is not us and not the provider we were told
 * about. Deliberately NOT an error: plenty of correct setups route through a
 * filtering gateway we don't recognise. We report what we found and stop.
 */
const otherMx = computed(
	() =>
		checked.value &&
		verdict.value !== undefined &&
		verdict.value.hasMx &&
		!verdict.value.pointsHere &&
		!confirmed.value
);
/**
 * The live lookup recognised a provider, and it is NOT the one the domain is
 * configured for. Worth saying because the generated SPF record authorizes the
 * DECLARED provider: mail this domain sends from the one actually receiving it
 * is not covered. Still a calm note — the setup may be mid-migration, and the
 * only state that means mail is being lost right now is `pointsHere`.
 */
const observedProvider = computed(() => verdict.value?.provider ?? null);
const providerMismatch = computed(
	() =>
		otherMx.value &&
		observedProvider.value !== null &&
		observedProvider.value !== (props.provider ?? null)
);
const observedProviderLabel = computed(() =>
	observedProvider.value ? t(EXTERNAL_RECEIVING_PROVIDER_KEYS[observedProvider.value]) : ''
);

// SPF, read off the RECORD (see the `spfValue` prop). Three states, in the order
// they are checked:
//   - no record at all — there is nothing above to point at, so saying "the SPF
//     record above already carries both" would be a sentence about nothing;
//   - merged — the generated record already authorizes both senders, publish it
//     verbatim;
//   - not merged — either we know the include and can name the exact term the
//     operator has to add, or we do not (`'other'`, no declared provider) and
//     the merge is entirely theirs.
const hasSpfRecord = computed(() => (props.spfValue ?? '').trim().length > 0);
const spfMerged = computed(() =>
	externalReceivingSpfMerged(props.spfValue, props.provider ?? undefined)
);
/** The term to add, when we know one and the stored record does not carry it. */
const missingSpfInclude = computed(() => {
	if (!hasSpfRecord.value || spfMerged.value) return null;
	const include = externalReceivingSpfInclude(props.provider ?? undefined);
	return include ? `include:${include}` : null;
});
</script>

<template>
	<div class="pt-2" data-testid="external-receiving">
		<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
			{{ t('components.domains.externalReceivingSection.heading') }}
		</p>

		<!-- The headline promise. Everything below is detail; this is the sentence
		     an operator has to be able to read without expanding anything. -->
		<div class="p-4 bg-bg-surface rounded-xl border border-border-subtle">
			<I18nT
				keypath="components.domains.externalReceivingSection.intro"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary"
			>
				<template #headline>
					<strong class="text-text-primary">
						{{ t('components.domains.externalReceivingSection.introHeadline') }}
					</strong>
				</template>
				<template #provider>
					<strong class="text-text-primary">{{ providerLabel }}</strong>
				</template>
				<template #domain>
					<strong class="text-text-primary">{{ domain }}</strong>
				</template>
			</I18nT>

			<!-- LIVE VERDICT. `pointsHere` first: it is the only state that means
			     inbound mail is being taken away from the provider right now. -->
			<I18nT
				v-if="pointsHere"
				keypath="components.domains.externalReceivingSection.mx.pointsHere"
				tag="p"
				scope="global"
				class="text-sm text-error mt-3"
				data-testid="external-receiving-points-here"
			>
				<template #headline>
					<strong>
						{{ t('components.domains.externalReceivingSection.mx.pointsHereHeadline') }}
					</strong>
				</template>
				<template #domain>{{ domain }}</template>
				<template #provider>{{ providerLabel }}</template>
				<template #hosts>
					<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ mxHosts }}</code>
				</template>
			</I18nT>

			<I18nT
				v-else-if="noMx"
				keypath="components.domains.externalReceivingSection.mx.missing"
				tag="p"
				scope="global"
				class="text-sm text-warning mt-3"
				data-testid="external-receiving-no-mx"
			>
				<template #domain>{{ domain }}</template>
				<template #provider>{{ providerLabel }}</template>
			</I18nT>

			<I18nT
				v-else-if="confirmed"
				keypath="components.domains.externalReceivingSection.mx.confirmed"
				tag="p"
				scope="global"
				class="text-sm text-success mt-3"
				data-testid="external-receiving-confirmed"
			>
				<template #domain>{{ domain }}</template>
				<template #provider>{{ providerLabel }}</template>
				<template #hosts>
					<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ mxHosts }}</code>
				</template>
			</I18nT>

			<I18nT
				v-else-if="otherMx"
				keypath="components.domains.externalReceivingSection.mx.elsewhere"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary mt-3"
				data-testid="external-receiving-elsewhere"
			>
				<template #domain>{{ domain }}</template>
				<template #hosts>
					<code class="bg-bg-deep px-1.5 py-0.5 rounded text-xs">{{ mxHosts }}</code>
				</template>
			</I18nT>

			<!-- We recognised the receiver, and it is not the one this domain is
			     configured for. The merged SPF authorizes the DECLARED provider, so
			     the mismatch has a concrete consequence — but it is a note, not an
			     error: `pointsHere` stays the only state that means mail is lost. -->
			<I18nT
				v-if="providerMismatch"
				keypath="components.domains.externalReceivingSection.mx.providerMismatch"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary mt-2"
				data-testid="external-receiving-provider-mismatch"
			>
				<template #headline>
					<strong class="text-text-primary">
						{{
							t('components.domains.externalReceivingSection.mx.providerMismatchHeadline', {
								observed: observedProviderLabel,
							})
						}}
					</strong>
				</template>
				<template #declared>{{ providerLabel }}</template>
				<template #observed>{{ observedProviderLabel }}</template>
			</I18nT>
		</div>

		<!-- The one MX Owlat does ask for lives on a subdomain of its own. Said
		     plainly, because "publish an MX" and "never touch your MX" otherwise
		     read as a contradiction. -->
		<I18nT
			v-if="returnPathHost"
			keypath="components.domains.externalReceivingSection.bounces.body"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary mt-3"
			data-testid="external-receiving-bounces"
		>
			<template #headline>
				<strong class="text-text-primary">
					{{ t('components.domains.externalReceivingSection.bounces.headline') }}
				</strong>
			</template>
			<template #host>
				<code class="bg-bg-surface px-1.5 py-0.5 rounded text-xs">{{ returnPathHost }}</code>
			</template>
			<template #domain>{{ domain }}</template>
		</I18nT>

		<!-- SPF, decided by the RECORD and not by the declared provider. Only the
		     first branch may claim the merge is done; the others say who has to do
		     it and with what, because a second `v=spf1` record is a permanent error
		     on every message the domain sends. -->
		<I18nT
			v-if="!hasSpfRecord"
			keypath="components.domains.externalReceivingSection.spf.none"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary mt-3"
			data-testid="external-receiving-spf-none"
		>
			<template #headline>
				<strong class="text-text-primary">
					{{ t('components.domains.externalReceivingSection.spf.noneHeadline') }}
				</strong>
			</template>
			<template #provider>{{ providerLabel }}</template>
		</I18nT>
		<I18nT
			v-else-if="spfMerged"
			keypath="components.domains.externalReceivingSection.spf.merged"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary mt-3"
			data-testid="external-receiving-spf-merged"
		>
			<template #headline>
				<strong class="text-text-primary">
					{{ t('components.domains.externalReceivingSection.spf.mergedHeadline') }}
				</strong>
			</template>
			<template #provider>{{ providerLabel }}</template>
		</I18nT>
		<I18nT
			v-else-if="missingSpfInclude"
			keypath="components.domains.externalReceivingSection.spf.addInclude"
			tag="p"
			scope="global"
			class="text-sm text-warning mt-3"
			data-testid="external-receiving-spf-add-include"
		>
			<template #headline>
				<strong>
					{{ t('components.domains.externalReceivingSection.spf.addIncludeHeadline') }}
				</strong>
			</template>
			<template #include>
				<code class="bg-bg-surface px-1.5 py-0.5 rounded text-xs">{{ missingSpfInclude }}</code>
			</template>
			<template #provider>{{ providerLabel }}</template>
		</I18nT>
		<I18nT
			v-else
			keypath="components.domains.externalReceivingSection.spf.manual"
			tag="p"
			scope="global"
			class="text-sm text-warning mt-3"
			data-testid="external-receiving-spf-manual"
		>
			<template #headline>
				<strong>{{ t('components.domains.externalReceivingSection.spf.manualHeadline') }}</strong>
			</template>
		</I18nT>

		<!-- "Owlat only sends" invites "then where do I read my mail?". Receiving
		     from the provider already works over IMAP — this is the path to it. -->
		<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
			<I18nT
				keypath="components.domains.externalReceivingSection.migrate.body"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary"
			>
				<template #headline>
					<strong class="text-text-primary">
						{{ t('components.domains.externalReceivingSection.migrate.headline') }}
					</strong>
				</template>
				<template #provider>{{ providerLabel }}</template>
			</I18nT>
			<NuxtLink
				to="/dashboard/postbox/migrate"
				class="inline-flex items-center gap-1 text-sm text-brand hover:underline mt-2"
			>
				{{ t('components.domains.externalReceivingSection.migrate.link') }}
				<Icon name="lucide:arrow-right" class="w-3.5 h-3.5" />
			</NuxtLink>
		</div>
	</div>
</template>
