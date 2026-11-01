<script setup lang="ts">
/**
 * The Configure step of the desktop setup wizard: feature packs, providers,
 * the domain and its DNS records, and the admin account, one wizard step at a
 * time. The entries and the provisioning call live in the page's config form;
 * this renders them.
 */
import { MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';
import type { DnsRecordRow } from '~/lib/desktop/provisioningForm';
import type { ConfigStep, SetupConfigForm } from '~/composables/desktopSetup/useSetupConfigForm';
import { hintClass, labelClass, sectionClass } from '~/composables/desktopSetup/setupFormClasses';
import { useLocalized } from '~/composables/useLocalized';
import TransportCredentialFields from '~/components/delivery/TransportCredentialFields.vue';

const props = defineProps<{
	form: SetupConfigForm;
	/** The SSH host is not this machine, so a domain is required. */
	isRemoteTarget: boolean;
	/** The SSH address is itself an IP, so no separate public IP is asked for. */
	hostIsIp: boolean;
	dnsRecords: DnsRecordRow[];
	/** `dnsRecords` with the starter SPF row merged into an existing one. */
	displayDnsRecords: DnsRecordRow[];
}>();

const { t } = useI18n();
/** Password assessment copy arrives as a message key, optionally with params. */
const tk = useLocalized();

const {
	packs,
	packOptions,
	sendingProvider,
	sendingCredentials,
	sendingPreset,
	sendingPresetOptions,
	sendingOptions,
	usesOwnMta,
	outboundTlsHint,
	aiProvider,
	aiKey,
	adminEmail,
	adminName,
	adminPassword,
	adminPasswordConfirm,
	revealPassword,
	passwordAssessment,
	adminPasswordError,
	domain,
	publicIp,
	hostLabels,
	HOST_LABEL_INACTIVE_HINT,
	disabledLabelKeys,
	labelValidation,
	seedDemo,
	configError,
	hasDomain,
	configSteps,
	stepOptions,
	configStep,
	stepIndex,
	isLastStep,
	goStep,
	nextStep,
	prevStep,
	onProvision,
} = props.form;
</script>

<template>
	<section class="card">
		<!-- step menu -->
		<nav class="mb-5" :aria-label="t('desktop.setup.stepsLabel')">
			<UiSegmentedControl
				:options="stepOptions"
				:model-value="configStep"
				@update:model-value="goStep($event as ConfigStep)"
			>
				<template v-for="st in configSteps" :key="st.id" #[`option-${st.id}`]>
					<Icon :name="st.icon" class="size-3.5 shrink-0" />
					<span class="hidden sm:inline">{{ t(st.label) }}</span>
				</template>
			</UiSegmentedControl>
		</nav>

		<form @submit.prevent="onProvision">
			<div v-show="configStep === 'features'">
				<label :class="sectionClass">{{ t('desktop.setup.sections.featurePacks') }}</label>
				<div class="space-y-1.5">
					<label
						v-for="opt in packOptions"
						:key="opt.key"
						class="flex cursor-pointer items-center gap-2.5 text-sm"
					>
						<input v-model="packs[opt.key]" type="checkbox" class="peer sr-only" />
						<span
							class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-2"
							:class="packs[opt.key] ? 'border-brand bg-brand' : 'border-border-default'"
						>
							<Icon v-if="packs[opt.key]" name="lucide:check" class="size-3 text-text-inverse" />
						</span>
						<span>{{ t(opt.label) }}</span>
					</label>
				</div>
			</div>

			<div v-show="configStep === 'providers'">
				<label :class="sectionClass">{{ t('desktop.setup.sections.emailSending') }}</label>
				<div class="relative">
					<select v-model="sendingProvider" class="input input-sm appearance-none pr-8">
						<option v-for="opt in sendingOptions" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<Icon
						name="lucide:chevron-down"
						class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
					/>
				</div>
				<!-- The selected kind's catalog credential fields; no per-provider markup. -->
				<TransportCredentialFields
					class="mt-3"
					:kind="sendingProvider"
					:values="sendingCredentials"
					:preset="sendingPreset"
					:preset-options="sendingPresetOptions"
					@update:preset="sendingPreset = $event"
				>
					<template #outboundTlsMode="{ value }">
						<p :class="hintClass">{{ t(outboundTlsHint(value)) }}</p>
					</template>
				</TransportCredentialFields>
				<I18nT
					v-if="usesOwnMta"
					keypath="desktop.setup.sending.mtaHint"
					tag="p"
					:class="hintClass"
					scope="global"
				>
					<template #outbound><span class="font-mono">mail.</span></template>
					<template #returns><span class="font-mono">bounce.</span></template>
				</I18nT>
			</div>

			<div v-show="configStep === 'providers'" class="mt-5">
				<label :class="sectionClass">{{ t('desktop.setup.sections.ai') }}</label>
				<div class="relative">
					<select v-model="aiProvider" class="input input-sm appearance-none pr-8">
						<option value="none">{{ t('common.none') }}</option>
						<option value="openrouter">{{ t('desktop.setup.ai.openrouter') }}</option>
						<option value="openai">{{ t('desktop.setup.ai.openai') }}</option>
						<option value="ollama">{{ t('desktop.setup.ai.ollama') }}</option>
					</select>
					<Icon
						name="lucide:chevron-down"
						class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
					/>
				</div>
				<input
					v-if="aiProvider === 'openrouter' || aiProvider === 'openai'"
					v-model="aiKey"
					class="input input-sm mt-2"
					:placeholder="t('desktop.setup.ai.keyPlaceholder')"
				/>
			</div>

			<div v-show="configStep === 'admin'">
				<label :class="sectionClass">{{ t('desktop.setup.sections.admin') }}</label>
				<div class="space-y-2">
					<input v-model="adminEmail" class="input input-sm" placeholder="admin@example.com" />
					<input
						v-model="adminName"
						class="input input-sm"
						:placeholder="t('desktop.setup.admin.namePlaceholder')"
					/>
					<div class="relative">
						<input
							v-model="adminPassword"
							:type="revealPassword ? 'text' : 'password'"
							class="input input-sm pr-10"
							autocomplete="new-password"
							:placeholder="
								t('desktop.setup.admin.passwordPlaceholder', { min: MIN_PASSWORD_LENGTH })
							"
						/>
						<button
							type="button"
							class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-label="
								revealPassword
									? t('desktop.setup.admin.hidePassword')
									: t('desktop.setup.admin.showPassword')
							"
							:aria-pressed="revealPassword"
							@click="revealPassword = !revealPassword"
						>
							<Icon :name="revealPassword ? 'lucide:eye-off' : 'lucide:eye'" class="size-4" />
						</button>
					</div>
					<input
						v-model="adminPasswordConfirm"
						:type="revealPassword ? 'text' : 'password'"
						class="input input-sm"
						autocomplete="new-password"
						:placeholder="t('desktop.setup.admin.confirmPasswordPlaceholder')"
					/>
					<!-- Live length + strength meter (validates before submit). -->
					<div v-if="adminPassword" class="flex items-center gap-2">
						<div class="flex h-1 flex-1 gap-1">
							<span
								v-for="seg in 4"
								:key="seg"
								class="h-full flex-1 rounded-full transition-colors"
								:class="
									seg <= passwordAssessment.score
										? passwordAssessment.strength === 'strong'
											? 'bg-success'
											: passwordAssessment.strength === 'fair'
												? 'bg-warning'
												: 'bg-error'
										: 'bg-border-default'
								"
							/>
						</div>
						<span
							class="w-20 shrink-0 text-right text-xs"
							:class="passwordAssessment.meetsMinLength ? 'text-text-secondary' : 'text-error'"
							>{{ tk(passwordAssessment.label) }}</span
						>
					</div>
					<p v-if="adminPasswordError" class="text-xs text-error">
						{{ tk(adminPasswordError) }}
					</p>
				</div>
			</div>

			<div v-show="configStep === 'domain'">
				<label :class="sectionClass">{{
					isRemoteTarget ? t('desktop.setup.domain.labelRequired') : t('desktop.setup.domain.label')
				}}</label>
				<input
					v-model="domain"
					class="input input-sm"
					:placeholder="
						isRemoteTarget
							? t('desktop.setup.domain.placeholderRequired')
							: t('desktop.setup.domain.placeholder')
					"
				/>
				<p class="mt-1.5 text-xs text-text-secondary">
					{{ t('desktop.setup.domain.hint') }}
					<I18nT v-if="isRemoteTarget" keypath="desktop.setup.domain.hintRemote" scope="global">
						<template #localhost><span class="font-mono">localhost</span></template>
					</I18nT>
					<template v-else>
						{{ t('desktop.setup.domain.hintLocal') }}
					</template>
				</p>
				<p v-if="isRemoteTarget && !hasDomain" class="mt-1.5 text-xs text-warning">
					<Icon name="lucide:triangle-alert" class="mb-0.5 mr-1 inline size-3.5" />
					{{ t('desktop.setup.domain.noDomainWarning') }}
				</p>

				<!-- Connected by hostname → the SSH address is not an IP. The wizard
				     auto-detects the public IP over the SSH session; this field lets
				     the operator override it if detection failed or was wrong. -->
				<div v-if="hasDomain && !hostIsIp" class="mt-3">
					<label :class="labelClass">{{ t('desktop.setup.domain.publicIpLabel') }}</label>
					<input
						v-model="publicIp"
						class="input input-sm font-mono"
						placeholder="203.0.113.5"
						inputmode="decimal"
					/>
					<p class="mt-1 text-xs text-text-secondary">
						{{ t('desktop.setup.domain.publicIpHint') }}
					</p>
				</div>

				<div>
					<div v-if="hasDomain" class="mt-2">
						<DesktopHostnameOverrides
							v-model="hostLabels"
							:domain="domain"
							:errors="labelValidation.errors"
							:disabled-keys="disabledLabelKeys"
							:disabled-hint="t(HOST_LABEL_INACTIVE_HINT)"
						/>
					</div>

					<div class="mt-3 overflow-x-auto rounded-lg border border-border-subtle bg-bg-deep p-3">
						<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
							{{ t('desktop.setup.dns.createTitle') }}
						</p>
						<DesktopDnsRecordList v-if="dnsRecords.length" :records="displayDnsRecords" />
						<p v-else class="text-xs text-text-secondary">
							{{ t('desktop.setup.dns.enterDomain')
							}}<template v-if="isRemoteTarget"
								>{{ ' ' }}{{ t('desktop.setup.dns.enterDomainRemote') }}</template
							><template v-else>{{ ' ' }}{{ t('desktop.setup.dns.enterDomainLocal') }}</template>
						</p>
						<p v-if="dnsRecords.length" class="mt-2 text-xs text-text-secondary">
							{{ t('desktop.setup.dns.tlsHint') }}
						</p>
						<p v-if="usesOwnMta && dnsRecords.length" class="mt-1.5 text-xs text-warning">
							<Icon name="lucide:info" class="mb-0.5 mr-1 inline size-3.5" />
							<I18nT keypath="desktop.setup.dns.deliverabilityHint" scope="global">
								<template #settings
									><span class="font-medium">{{
										t('desktop.setup.dns.settingsDomains')
									}}</span></template
								>
							</I18nT>
						</p>
					</div>
				</div>
			</div>

			<label
				v-show="configStep === 'admin'"
				class="mt-4 flex cursor-pointer items-center gap-2.5 text-sm"
			>
				<input v-model="seedDemo" type="checkbox" class="peer sr-only" />
				<span
					class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-2"
					:class="seedDemo ? 'border-brand bg-brand' : 'border-border-default'"
				>
					<Icon v-if="seedDemo" name="lucide:check" class="size-3 text-text-inverse" />
				</span>
				<span>{{ t('desktop.setup.admin.seedDemo') }}</span>
			</label>

			<p v-if="configError" class="mt-4 text-sm text-error">{{ configError }}</p>
			<div class="mt-5 flex items-center gap-3 border-t border-border-subtle pt-4">
				<UiButton v-if="stepIndex > 0" variant="outline" size="sm" @click="prevStep">
					{{ t('common.back') }}
				</UiButton>
				<UiButton v-if="!isLastStep" size="sm" class="ml-auto" @click="nextStep">
					{{ t('common.next') }}
				</UiButton>
				<UiButton v-else type="submit" size="sm" class="ml-auto">
					{{ t('desktop.setup.provision') }}
				</UiButton>
			</div>
		</form>
	</section>
</template>
