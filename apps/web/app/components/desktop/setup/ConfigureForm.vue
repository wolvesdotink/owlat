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
import {
	ChevronDownIcon,
	CircleInfoIcon,
	EyeIcon,
	EyeOffIcon,
	TriangleWarningIcon,
} from '@coolicons/vue';

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

// Fields are named by visible labels (for/id), and section titles are headings
// that name the controls under them, not labels bound to nothing.
const uid = useId();
const fid = (name: string) => `${uid}-${name}`;
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
					<component :is="st.icon" class="size-3.5 shrink-0" aria-hidden="true" />
					<!-- Hidden visually on a phone, never from a screen reader. -->
					<span class="sr-only sm:not-sr-only">{{ t(st.label) }}</span>
				</template>
			</UiSegmentedControl>
		</nav>

		<form @submit.prevent="onProvision">
			<div v-show="configStep === 'features'">
				<h3 :id="fid('packs')" :class="sectionClass">
					{{ t('desktop.setup.sections.featurePacks') }}
				</h3>
				<!-- Native checkboxes in the shared UiCheckbox look (accent-brand),
				     matching the ones on the Connect step. -->
				<div class="space-y-1.5" role="group" :aria-labelledby="fid('packs')">
					<label
						v-for="opt in packOptions"
						:key="opt.key"
						class="flex cursor-pointer items-center gap-2.5 text-sm"
					>
						<input
							v-model="packs[opt.key]"
							type="checkbox"
							class="h-4 w-4 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2"
						/>
						<span>{{ t(opt.label) }}</span>
					</label>
				</div>
			</div>

			<div v-show="configStep === 'providers'">
				<h3 :id="fid('sending')" :class="sectionClass">
					{{ t('desktop.setup.sections.emailSending') }}
				</h3>
				<div class="relative">
					<select
						v-model="sendingProvider"
						class="input input-sm appearance-none pr-8"
						:aria-labelledby="fid('sending')"
					>
						<option v-for="opt in sendingOptions" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<ChevronDownIcon
						class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
						aria-hidden="true"
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
				<h3 :id="fid('ai')" :class="sectionClass">{{ t('desktop.setup.sections.ai') }}</h3>
				<div class="relative">
					<select
						v-model="aiProvider"
						class="input input-sm appearance-none pr-8"
						:aria-labelledby="fid('ai')"
					>
						<option value="none">{{ t('common.none') }}</option>
						<option value="openrouter">{{ t('desktop.setup.ai.openrouter') }}</option>
						<option value="openai">{{ t('desktop.setup.ai.openai') }}</option>
						<option value="ollama">{{ t('desktop.setup.ai.ollama') }}</option>
					</select>
					<ChevronDownIcon
						class="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-secondary"
						aria-hidden="true"
					/>
				</div>
				<!-- A secret: masked like a password, and never offered to autofill. -->
				<input
					v-if="aiProvider === 'openrouter' || aiProvider === 'openai'"
					v-model="aiKey"
					type="password"
					autocomplete="off"
					spellcheck="false"
					class="input input-sm mt-2"
					:placeholder="t('desktop.setup.ai.keyPlaceholder')"
					:aria-label="t('desktop.setup.ai.keyPlaceholder')"
				/>
			</div>

			<div v-show="configStep === 'admin'">
				<h3 :class="sectionClass">{{ t('desktop.setup.sections.admin') }}</h3>
				<div class="space-y-2">
					<div>
						<label :for="fid('admin-email')" :class="labelClass">{{
							t('desktop.setup.admin.emailLabel')
						}}</label>
						<!-- Not type="email": the wizard validates and explains a bad address
						     itself, where the browser's popup would pre-empt it. -->
						<input
							:id="fid('admin-email')"
							v-model="adminEmail"
							class="input input-sm"
							inputmode="email"
							autocomplete="email"
							autocapitalize="off"
							spellcheck="false"
							placeholder="admin@example.com"
						/>
					</div>
					<div>
						<label :for="fid('admin-name')" :class="labelClass">{{
							t('desktop.setup.admin.nameLabel')
						}}</label>
						<input
							:id="fid('admin-name')"
							v-model="adminName"
							class="input input-sm"
							autocomplete="name"
							:placeholder="t('desktop.setup.admin.namePlaceholder')"
						/>
					</div>
					<label :for="fid('admin-password')" :class="labelClass">{{
						t('desktop.setup.admin.passwordLabel')
					}}</label>
					<div class="relative">
						<input
							:id="fid('admin-password')"
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
							<component
								:is="revealPassword ? EyeOffIcon : EyeIcon"
								class="size-4"
								aria-hidden="true"
							/>
						</button>
					</div>
					<label :for="fid('admin-password-confirm')" :class="labelClass">{{
						t('desktop.setup.admin.confirmPasswordLabel')
					}}</label>
					<input
						:id="fid('admin-password-confirm')"
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
					<p v-if="adminPasswordError" class="text-xs text-error" role="alert">
						{{ tk(adminPasswordError) }}
					</p>
				</div>
			</div>

			<div v-show="configStep === 'domain'">
				<label :for="fid('domain')" :class="sectionClass">{{
					isRemoteTarget ? t('desktop.setup.domain.labelRequired') : t('desktop.setup.domain.label')
				}}</label>
				<input
					:id="fid('domain')"
					v-model="domain"
					autocapitalize="off"
					spellcheck="false"
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
					<TriangleWarningIcon class="mb-0.5 mr-1 inline size-3.5" aria-hidden="true" />
					{{ t('desktop.setup.domain.noDomainWarning') }}
				</p>

				<!-- Connected by hostname → the SSH address is not an IP. The wizard
				     auto-detects the public IP over the SSH session; this field lets
				     the operator override it if detection failed or was wrong. -->
				<div v-if="hasDomain && !hostIsIp" class="mt-3">
					<label :for="fid('public-ip')" :class="labelClass">{{
						t('desktop.setup.domain.publicIpLabel')
					}}</label>
					<input
						:id="fid('public-ip')"
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
							<CircleInfoIcon class="mb-0.5 mr-1 inline size-3.5" aria-hidden="true" />
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
				<input
					v-model="seedDemo"
					type="checkbox"
					class="h-4 w-4 shrink-0 accent-brand focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2"
				/>
				<span>{{ t('desktop.setup.admin.seedDemo') }}</span>
			</label>

			<p v-if="configError" class="mt-4 text-sm text-error" role="alert">{{ configError }}</p>
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
