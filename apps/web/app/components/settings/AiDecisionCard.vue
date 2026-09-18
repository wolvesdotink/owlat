<script setup lang="ts">
/**
 * The DECISION plane's card on the AI-provider settings page — the third card,
 * built from the same parts as the two above it (provider select, key field with
 * masked preview, model id, base URL, test button) rather than a visual language
 * of its own.
 *
 * What is new here is not the anatomy, it is the three things the plane needs an
 * operator to actually decide:
 *
 *  • CONSENT, before anything is enabled. It names the vendor, the host, what
 *    text leaves the deployment and where the vendor's privacy statement is, so
 *    an operator can answer their own DPO from this card. Owlat is self-hosted
 *    and brokers no keys: the key is theirs, the processor relationship is
 *    theirs, and we say so instead of implying otherwise.
 *  • FALLBACK, per surface, because the one hop onto the language plane is a
 *    cost lever a stranger can pull by making decisions fail. On for the agent
 *    pipeline, never for the high-volume background classifiers.
 *  • THRESHOLDS, named per answer type. A yes/no answer carries no confidence
 *    at all — its threshold is distance from 0.5 — so a single "confidence"
 *    slider would silently mean two different quantities.
 *
 * The degraded state is words, not a `disabled` attribute: when the plane
 * resolves uncalibrated, or the last test failed, the card says which and what
 * happens instead, and the thresholds are stated as inert.
 *
 * The parent owns all of it (`composables/useAiDecisionPlane.ts`); this file
 * binds and paints. Option and surface labels arrive as MESSAGE KEYS and are
 * translated here, the same contract `utils/aiProviders.ts` documents.
 */
import { computed, ref, watch } from 'vue';
import { decisionHealthRows } from '~/utils/aiDecisionPlane';
import type {
	DecisionDegradedReason,
	DecisionFallbackSurface,
	DecisionPlaneHealth,
	DecisionThreshold,
} from '~/utils/aiDecisionPlane';
import type {
	DecisionProviderKind,
	DecisionProviderMeta,
	SelectOption,
	TestConnectionState,
} from '~/utils/aiProviders';

const props = defineProps<{
	/** Provider options, labels still as message keys — translated below. */
	options: { value: DecisionProviderKind; label: string }[];
	meta?: DecisionProviderMeta;
	requiresKey: boolean;
	modelOptions: SelectOption[];
	/** The host every decision request goes to, for the consent block. */
	endpointHost: string;
	storedKeySet: boolean;
	keyPreview?: string;
	/** Blocking validation, already translated by the parent. */
	error: string | null;
	/** Non-blocking note under the key field, as a message key. */
	keyHint: string | null;
	consentOwed: boolean;
	degradedReasons: DecisionDegradedReason[];
	thresholdsInert: boolean;
	fallbackSurfaces: readonly DecisionFallbackSurface[];
	thresholds: readonly DecisionThreshold[];
	testState: TestConnectionState;
	/** What the plane actually did recently, or null when it has answered nothing. */
	health: DecisionPlaneHealth | null;
	/** The window `health` covers, named in the block's own copy. */
	healthHours: number;
	isTesting: boolean;
	isSaving: boolean;
	/** False while the form is dirty or unsaved — the test reads the STORED row. */
	canTest: boolean;
}>();

const emit = defineEmits<{ test: [] }>();

const enabled = defineModel<boolean>('enabled', { required: true });
const kind = defineModel<DecisionProviderKind>('kind', { required: true });
const modelChoice = defineModel<string>('modelChoice', { required: true });
const modelCustom = defineModel<string>('modelCustom', { required: true });
const baseUrl = defineModel<string>('baseUrl', { required: true });
const apiKey = defineModel<string>('apiKey', { required: true });
const fallbackEnabled = defineModel<boolean>('fallbackEnabled', { required: true });
const consent = defineModel<boolean>('consent', { required: true });

const { t } = useI18n();

const providerOptions = computed(() =>
	props.options.map((option) => ({ ...option, label: t(option.label) }))
);

const healthRows = computed(() => (props.health ? decisionHealthRows(props.health) : []));
// Whole percent: these are rates over a few hundred calls at most, and a decimal
// place would imply a precision the window does not have.
const formatRate = (rate: number) => `${Math.round(rate * 100)}%`;

// A stored origin override is never "advanced" for the operator who set it —
// reveal the field when there is something in it, hidden otherwise.
const showBaseUrl = ref(baseUrl.value.trim().length > 0);
watch(baseUrl, (value) => {
	if (value.trim().length > 0) showBaseUrl.value = true;
});
</script>

<template>
	<UiCard>
		<h2 class="text-lg font-medium text-text-primary mb-1">
			{{ t('dashboard.admin.instance.aiProvider.decision.title') }}
		</h2>
		<p class="text-sm text-text-secondary mb-4">
			{{ t('dashboard.admin.instance.aiProvider.decision.description') }}
		</p>

		<!--
			The resting state, and the one every install that never opted in sees:
			the same "nothing to set up" panel the embeddings card uses for its
			bundled default, because this is the same kind of answer.
		-->
		<div
			v-if="!enabled"
			class="flex items-start gap-3 rounded-lg bg-success-subtle/50 border border-border-subtle p-4"
		>
			<Icon name="lucide:check-circle-2" class="w-5 h-5 text-success shrink-0 mt-0.5" />
			<div class="text-sm">
				<p class="text-text-primary font-medium">
					{{ t('dashboard.admin.instance.aiProvider.decision.offTitle') }}
				</p>
				<p class="text-text-secondary mt-0.5">
					{{ t('dashboard.admin.instance.aiProvider.decision.offBody') }}
				</p>
			</div>
		</div>

		<div class="mt-4">
			<UiDisclosure
				v-model="enabled"
				:label="t('dashboard.admin.instance.aiProvider.decision.enableDisclosure')"
				controls="ai-decision-plane"
				:disabled="isSaving"
			>
				<div class="space-y-6">
					<div>
						<UiSelect
							v-model="kind"
							:label="t('dashboard.admin.instance.aiProvider.decision.providerLabel')"
							:options="providerOptions"
							:disabled="isSaving"
						/>
						<p v-if="meta" class="mt-1.5 text-xs text-text-tertiary">
							{{ t(meta.hint) }}
							<a
								v-if="meta.docsUrl"
								:href="meta.docsUrl"
								target="_blank"
								rel="noopener"
								class="text-brand hover:underline whitespace-nowrap"
							>
								{{ t('dashboard.admin.instance.aiProvider.decision.getKey') }} →
							</a>
						</p>
					</div>

					<!--
						Consent, before anything is enabled — and only the first time this
						vendor is turned on, because a screen an operator has learned to
						click past has stopped being consent.
					-->
					<div
						v-if="consentOwed"
						class="rounded-lg border border-border-subtle bg-warning-subtle/40 p-4 space-y-2 text-sm"
					>
						<p class="text-text-primary font-medium">
							{{ t('dashboard.admin.instance.aiProvider.decision.consent.title') }}
						</p>
						<p class="text-text-secondary">
							{{ t('dashboard.admin.instance.aiProvider.decision.consent.vendor') }}
						</p>
						<p class="text-text-secondary">
							{{
								t('dashboard.admin.instance.aiProvider.decision.consent.endpoint', {
									host: endpointHost,
								})
							}}
						</p>
						<p class="text-text-secondary">
							{{ t('dashboard.admin.instance.aiProvider.decision.consent.payload') }}
						</p>
						<p class="text-text-secondary">
							{{ t('dashboard.admin.instance.aiProvider.decision.consent.retention') }}
						</p>
						<p class="text-text-secondary">
							{{ t('dashboard.admin.instance.aiProvider.decision.consent.controller') }}
						</p>
						<a
							v-if="meta?.privacyUrl"
							:href="meta.privacyUrl"
							target="_blank"
							rel="noopener"
							class="inline-block text-brand hover:underline"
						>
							{{ t('dashboard.admin.instance.aiProvider.decision.consent.privacyLink') }} →
						</a>
						<div class="pt-2">
							<UiCheckbox
								v-model="consent"
								:disabled="isSaving"
								:label="t('dashboard.admin.instance.aiProvider.decision.consent.acknowledge')"
							/>
						</div>
						<p v-if="error" class="text-sm text-error">{{ error }}</p>
					</div>

					<div v-if="requiresKey">
						<SettingsAiKeyField
							v-model="apiKey"
							:label="t('dashboard.admin.instance.aiProvider.decision.apiKeyLabel')"
							:stored-key-set="storedKeySet"
							:key-preview="keyPreview"
							:disabled="isSaving"
							:help-text="t('dashboard.admin.instance.aiProvider.decision.apiKeyHelp')"
						/>
						<p v-if="keyHint" class="mt-1.5 text-xs text-text-tertiary">{{ t(keyHint) }}</p>
					</div>

					<SettingsAiModelPicker
						v-if="requiresKey"
						v-model:choice="modelChoice"
						v-model:custom="modelCustom"
						:label="t('dashboard.admin.instance.aiProvider.decision.modelLabel')"
						:options="modelOptions"
						:disabled="isSaving"
						:hint="t('dashboard.admin.instance.aiProvider.decision.modelHint')"
					/>

					<div v-if="requiresKey">
						<UiDisclosure
							v-model="showBaseUrl"
							:label="t('dashboard.admin.instance.aiProvider.decision.baseUrlDisclosure')"
							controls="ai-decision-base-url"
							:disabled="isSaving"
						>
							<UiInput
								v-model="baseUrl"
								type="text"
								:label="t('dashboard.admin.instance.aiProvider.decision.baseUrlLabel')"
								:placeholder="meta?.defaultBaseUrl ?? 'https://…'"
								:disabled="isSaving"
								:help-text="t('dashboard.admin.instance.aiProvider.decision.baseUrlHelp')"
							/>
						</UiDisclosure>
					</div>

					<!--
						The degraded state, in words. Every reason that stands is listed:
						an operator who is told only the first one fixes it and finds the
						plane still not answering.
					-->
					<div
						v-if="degradedReasons.length"
						class="rounded-lg border border-border-subtle bg-warning-subtle/50 p-4 text-sm"
					>
						<div class="flex items-start gap-3">
							<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
							<div class="space-y-1">
								<p class="text-text-primary font-medium">
									{{ t('dashboard.admin.instance.aiProvider.decision.degraded.title') }}
								</p>
								<p
									v-for="reason in degradedReasons"
									:key="reason"
									class="text-text-secondary"
								>
									{{ t(`dashboard.admin.instance.aiProvider.decision.degraded.${reason}`) }}
								</p>
							</div>
						</div>
					</div>

					<!--
						What the plane DID, not what it is configured to do. Three rates off
						the ledger the spend ceiling reads: the expensive hop, the answers
						that arrived uncalibrated, and the provider pushing back. Hidden
						entirely until the plane has answered something, because a row of
						zeroes reads as a problem rather than as silence.
					-->
					<div
						v-if="health"
						class="rounded-lg border border-border-subtle p-4 text-sm"
					>
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.instance.aiProvider.decision.health.title') }}
						</h3>
						<p class="mt-1 text-xs text-text-tertiary">
							{{
								t('dashboard.admin.instance.aiProvider.decision.health.description', {
									hours: healthHours,
								})
							}}
						</p>
						<div class="mt-3 space-y-2">
							<div
								v-for="row in healthRows"
								:key="row.id"
								class="flex items-center justify-between gap-4"
							>
								<span class="text-text-secondary">
									{{ t(`dashboard.admin.instance.aiProvider.decision.health.${row.id}`) }}
								</span>
								<span class="text-text-primary font-medium">{{ formatRate(row.rate) }}</span>
							</div>
						</div>
						<p class="mt-3 text-xs text-text-tertiary">
							{{
								t('dashboard.admin.instance.aiProvider.decision.health.attempts', {
									count: health.attempts,
								})
							}}
						</p>
					</div>

					<div>
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.instance.aiProvider.decision.fallback.title') }}
						</h3>
						<p class="mt-1 text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.aiProvider.decision.fallback.description') }}
						</p>
						<div class="mt-3 space-y-3">
							<div
								v-for="surface in fallbackSurfaces"
								:key="surface.id"
								class="flex items-start justify-between gap-4 rounded-lg border border-border-subtle p-3"
							>
								<div class="text-sm">
									<p class="text-text-primary font-medium">{{ t(surface.label) }}</p>
									<p class="text-text-secondary mt-0.5">{{ t(surface.body) }}</p>
								</div>
								<UiSwitch
									v-if="surface.operatorControlled"
									v-model="fallbackEnabled"
									:disabled="isSaving"
									:label="t(surface.label)"
								/>
								<!--
									Not a disabled switch: there is no setting behind it. The
									classifiers never hop, and a greyed-out control would invite
									an operator to go looking for the permission to change it.
								-->
								<span
									v-else
									class="shrink-0 rounded-full bg-bg-surface-hover px-2.5 py-1 text-xs text-text-secondary"
								>
									{{ t('dashboard.admin.instance.aiProvider.decision.fallback.never') }}
								</span>
							</div>
						</div>
					</div>

					<div>
						<h3 class="text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.instance.aiProvider.decision.thresholds.title') }}
						</h3>
						<p class="mt-1 text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.aiProvider.decision.thresholds.description') }}
						</p>
						<div class="mt-3 space-y-3">
							<div
								v-for="threshold in thresholds"
								:key="threshold.id"
								class="rounded-lg border border-border-subtle p-3 text-sm"
							>
								<p class="text-text-primary font-medium">{{ t(threshold.label) }}</p>
								<p class="text-text-secondary mt-0.5">{{ t(threshold.body) }}</p>
							</div>
						</div>
						<p v-if="thresholdsInert" class="mt-3 text-xs text-warning">
							{{ t('dashboard.admin.instance.aiProvider.decision.thresholds.inert') }}
						</p>
						<p v-else class="mt-3 text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.aiProvider.decision.thresholds.active') }}
						</p>
					</div>

					<div class="flex flex-wrap items-center gap-3">
						<UiButton
							type="button"
							variant="secondary"
							size="sm"
							:loading="isTesting"
							:disabled="isSaving || isTesting || !canTest"
							@click="emit('test')"
						>
							<template #iconLeft>
								<Icon v-if="!isTesting" name="lucide:plug-zap" class="w-4 h-4" />
							</template>
							{{ t('dashboard.admin.instance.aiProvider.decision.testConnection') }}
						</UiButton>
						<p
							v-if="testState.status === 'ok'"
							class="text-sm text-success flex items-center gap-1.5"
						>
							<Icon name="lucide:check" class="w-4 h-4" />
							{{ t('dashboard.admin.instance.aiProvider.decision.testOk') }}
						</p>
						<p
							v-else-if="testState.status === 'error'"
							class="text-sm text-error flex items-center gap-1.5"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
							{{ testState.message }}
						</p>
						<p v-else-if="!canTest" class="text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.aiProvider.decision.saveFirstTest') }}
						</p>
					</div>

					<p v-if="error && !consentOwed" class="text-sm text-error">{{ error }}</p>
				</div>
			</UiDisclosure>
		</div>
	</UiCard>
</template>
