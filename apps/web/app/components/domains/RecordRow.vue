<script setup lang="ts">
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatDateTime } from '~/utils/formatters';
import { domainReadinessMessage } from '~/utils/domainReadiness';
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import {
	getStatusBadgeClass,
	getStatusIcon,
	normalizeDnsRecord,
	hasDnsRecords,
	readinessSummary,
	type DmarcPolicy,
} from '~/utils/domainStatus';

type DomainRow = FunctionReturnType<typeof api.domains.domains.listByOrganization>[number];

defineProps<{
	domain: DomainRow;
	isExpanded: boolean;
	canForceVerify: boolean;
	canManageDomains: boolean;
	isForcing: boolean;
	isVerifying: boolean;
	isUpdatingDmarc: boolean;
	autoRecheckActive: boolean;
	spfCoexistence: SpfCoexistenceSuggestion | null;
	dmarcPolicyOptions: { value: DmarcPolicy; label: string; hint: string }[];
	showReceivingDns: boolean;
	inboundMailHost: string | null;
	inboundPort: number;
	inboundEnabled: boolean;
}>();

const emit = defineEmits<{
	toggle: [];
	forceVerify: [];
	verify: [];
	retryRegistration: [];
	delete: [];
	dmarcChange: [policy: DmarcPolicy];
}>();
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<!-- Domain Header -->
		<div
			class="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
			role="button"
			tabindex="0"
			:aria-expanded="isExpanded"
			:aria-controls="`domain-records-${domain._id}`"
			:aria-label="`DNS records for ${domain.domain}`"
			@click="emit('toggle')"
			@keydown.enter.self="emit('toggle')"
			@keydown.space.self.prevent="emit('toggle')"
		>
			<div class="flex items-center gap-4">
				<UiIconBox icon="lucide:globe" size="sm" variant="surface" rounded="lg" />
				<div>
					<div class="flex items-center gap-3">
						<p class="font-medium text-text-primary">{{ domain.domain }}</p>
						<span
							:class="[
								'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
								getStatusBadgeClass(domain.status),
							]"
						>
							<Icon
								:name="getStatusIcon(domain.status)"
								:class="['w-3 h-3', domain.status === 'registering' && 'animate-spin']"
							/>
							{{ capitalize(domain.status) }}
						</span>
					</div>
					<p class="text-sm text-text-tertiary mt-0.5">
						<span v-if="domain.status === 'registering'"> Setting up domain... </span>
						<span v-else-if="domain.status === 'failed' && domain.lastRegistrationError">
							Registration failed — click Retry to try again
						</span>
						<span v-else-if="domain.status === 'verified'">
							Verified {{ formatDateTime(domain.verifiedAt) }}
						</span>
						<span v-else-if="domain.lastVerifiedAt">
							Last checked {{ formatDateTime(domain.lastVerifiedAt) }}
						</span>
						<span v-else> Added {{ formatDateTime(domain.createdAt) }} </span>
					</p>
				</div>
			</div>

			<div class="flex items-center gap-2">
				<button
					v-if="canForceVerify && domain.status !== 'verified'"
					class="btn gap-1.5 text-sm py-1.5 px-3 border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
					title="Skip DNS verification and mark this domain as verified — dev/selfhost only"
					:disabled="isForcing"
					@click.stop="emit('forceVerify')"
				>
					<Icon v-if="isForcing" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:wand-2" class="w-4 h-4" />
					Force Verify
					<span
						class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-warning/20 uppercase tracking-wide"
					>
						Dev
					</span>
				</button>
				<button
					class="btn btn-secondary gap-1.5 text-sm py-1.5 px-3"
					:title="
						domain.status === 'registering' ? 'Waiting for registration...' : 'Verify DNS records'
					"
					:disabled="isVerifying || domain.status === 'registering'"
					@click.stop="
						domain.status === 'failed' && domain.lastRegistrationError
							? emit('retryRegistration')
							: emit('verify')
					"
				>
					<Icon
						v-if="isVerifying || domain.status === 'registering'"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin"
					/>
					<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
					<template v-if="domain.status === 'registering'">Registering...</template>
					<template v-else-if="domain.status === 'failed' && domain.lastRegistrationError"
						>Retry</template
					>
					<template v-else>{{ isVerifying ? 'Verifying...' : 'Verify' }}</template>
				</button>
				<button
					class="btn btn-ghost p-2 text-error hover:bg-error/10"
					title="Remove domain"
					aria-label="Remove domain"
					@click.stop="emit('delete')"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</button>
				<div
					:class="[
						'w-5 h-5 flex items-center justify-center transition-transform',
						isExpanded ? 'rotate-180' : '',
					]"
				>
					<svg
						class="w-4 h-4 text-text-tertiary"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</div>
			</div>
		</div>

		<!-- DNS Records (Expanded) -->
		<Transition name="expand">
			<div
				v-if="isExpanded"
				:id="`domain-records-${domain._id}`"
				class="border-t border-border-subtle"
			>
				<div class="px-6 py-4 bg-bg-surface/30">
					<!-- Registering state -->
					<div
						v-if="domain.status === 'registering'"
						class="flex items-center gap-3 py-8 justify-center"
					>
						<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-info" />
						<p class="text-sm text-text-secondary">
							Setting up domain. DNS records will appear shortly...
						</p>
					</div>

					<!-- Registration error -->
					<div v-else-if="domain.status === 'failed' && domain.lastRegistrationError" class="py-4">
						<div class="p-4 bg-error/5 border border-error/20 rounded-xl mb-4">
							<p class="text-sm text-error font-medium mb-1">Registration Failed</p>
							<p class="text-sm text-text-secondary">
								{{ domain.lastRegistrationError }}
							</p>
						</div>
						<button class="btn btn-primary gap-2" @click="emit('retryRegistration')">
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
							Retry Registration
						</button>
					</div>

					<!-- DNS records (normal state) -->
					<template v-else-if="hasDnsRecords(domain.dnsRecords)">
						<div class="flex items-center justify-between gap-3 mb-4">
							<h4 class="text-sm font-medium text-text-primary">
								Configure these DNS records with your domain provider:
							</h4>
							<!-- Subtle auto-recheck indicator: we quietly re-verify while
							     this panel is open so the user needn't keep clicking Verify. -->
							<span
								v-if="autoRecheckActive && isExpanded"
								class="inline-flex items-center gap-1.5 text-xs text-text-secondary whitespace-nowrap"
								title="We recheck your DNS automatically every 30 seconds while this panel is open."
							>
								<Icon name="lucide:loader-2" class="w-3 h-3 animate-spin" />
								Checking DNS…
							</span>
						</div>

						<!-- One-line domain readiness summary derived purely from the
						     verification data already on the domain. -->
						<div
							v-if="readinessSummary(domain).total > 0"
							class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4 text-sm"
						>
							<div class="flex flex-wrap items-center gap-1.5">
								<span
									v-for="chip in readinessSummary(domain).chips"
									:key="chip.label"
									class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium"
									:class="
										chip.verified
											? 'bg-success/20 text-success border-success/30'
											: 'bg-error/20 text-error border-error/30'
									"
								>
									<Icon
										:name="chip.verified ? 'lucide:check-circle-2' : 'lucide:x-circle'"
										class="w-3 h-3"
									/>
									{{ chip.label }}
								</span>
							</div>
							<span
								:class="
									readinessSummary(domain).allVerified ? 'text-success' : 'text-text-secondary'
								"
							>
								{{ domainReadinessMessage(readinessSummary(domain)) }}
							</span>
						</div>

						<div class="space-y-4">
							<DomainsDNSRecordPanel
								v-if="normalizeDnsRecord(domain.dnsRecords.spf, 'TXT')"
								:record="normalizeDnsRecord(domain.dnsRecords.spf, 'TXT')!"
								label="SPF"
								:domain="domain.domain"
								:verification="domain.verificationResults?.spf"
								:coexistence="isExpanded ? (spfCoexistence ?? undefined) : undefined"
							/>

							<DomainsDNSRecordPanel
								v-for="(dkimRecord, i) in domain.dnsRecords.dkim"
								:key="`dkim-${i}`"
								:record="normalizeDnsRecord(dkimRecord, 'CNAME')!"
								:label="`DKIM ${i + 1}`"
								:domain="domain.domain"
								:verification="domain.verificationResults?.dkim?.[i]"
							/>

							<DomainsDNSRecordPanel
								v-if="normalizeDnsRecord(domain.dnsRecords.dmarc, 'TXT')"
								:record="normalizeDnsRecord(domain.dnsRecords.dmarc, 'TXT')!"
								label="DMARC"
								:domain="domain.domain"
								:verification="domain.verificationResults?.dmarc"
							/>

							<!-- DMARC enforcement policy selector -->
							<div
								v-if="normalizeDnsRecord(domain.dnsRecords.dmarc, 'TXT')"
								class="p-4 bg-bg-surface rounded-xl border border-border-subtle"
							>
								<label
									:for="`dmarc-policy-${domain._id}`"
									class="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2"
								>
									DMARC enforcement policy
								</label>
								<div class="flex items-center gap-3">
									<select
										:id="`dmarc-policy-${domain._id}`"
										class="input flex-1"
										:value="domain.dmarcPolicy ?? 'none'"
										:disabled="!canManageDomains || isUpdatingDmarc"
										@change="
											emit('dmarcChange', ($event.target as HTMLSelectElement).value as DmarcPolicy)
										"
									>
										<option v-for="opt in dmarcPolicyOptions" :key="opt.value" :value="opt.value">
											{{ opt.label }}
										</option>
									</select>
									<Icon
										v-if="isUpdatingDmarc"
										name="lucide:loader-2"
										class="w-4 h-4 animate-spin text-text-tertiary"
									/>
								</div>
								<p class="mt-2 text-xs text-text-secondary">
									{{
										dmarcPolicyOptions.find((o) => o.value === (domain.dmarcPolicy ?? 'none'))?.hint
									}}
									Start at monitor-only, then raise to quarantine or reject once SPF + DKIM are
									aligned. Changing this updates the _dmarc record above — re-publish it and verify
									again.
								</p>
							</div>

							<!-- MAIL FROM records -->
							<template v-if="domain.dnsRecords.mailFrom && domain.dnsRecords.mailFrom.length > 0">
								<div class="pt-2">
									<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
										MAIL FROM Domain (mail.{{ domain.domain }})
									</p>
									<div class="space-y-4">
										<DomainsDNSRecordPanel
											v-for="(mailFromRecord, i) in domain.dnsRecords.mailFrom"
											:key="`mailfrom-${i}`"
											:record="
												normalizeDnsRecord(
													mailFromRecord,
													mailFromRecord.type === 'MX' ? 'MX' : 'TXT'
												)!
											"
											:label="mailFromRecord.type === 'MX' ? 'MAIL FROM MX' : 'MAIL FROM SPF'"
											:domain="domain.domain"
											:verification="domain.verificationResults?.mailFrom?.[i]"
										/>
									</div>
								</div>
							</template>
						</div>
					</template>

					<!-- Receiving (inbound MX) — renders whenever the deployment exposes a
					     mail host, whether or not inbound is enabled yet; the section
					     itself shows a "not turned on yet" state when off so setup
					     is not a chicken-and-egg. -->
					<div
						v-if="
							showReceivingDns &&
							domain.status !== 'registering' &&
							!(domain.status === 'failed' && domain.lastRegistrationError)
						"
						class="mt-4 pt-4 border-t border-border-subtle"
					>
						<DomainsReceivingDnsSection
							:domain="domain.domain"
							:mail-host="inboundMailHost"
							:inbound-port="inboundPort"
							:inbound-enabled="inboundEnabled"
						/>
					</div>

					<!-- Help Text -->
					<div
						v-if="
							domain.status !== 'registering' &&
							!(domain.status === 'failed' && domain.lastRegistrationError)
						"
						class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle"
					>
						<p class="text-sm text-text-secondary">
							<strong class="text-text-primary">Note:</strong> DNS changes can take up to 48 hours
							to propagate. After adding these records, click "Verify Domain" to check the
							configuration.
							<a
								href="https://docs.owlat.app/developer/self-hosting-dns-email"
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 text-brand hover:underline ml-1"
							>
								Learn more
								<Icon name="lucide:external-link" class="w-3 h-3" />
							</a>
						</p>
					</div>
				</div>
			</div>
		</Transition>
	</div>
</template>

<style scoped>
/* Expand transition */
.expand-enter-active,
.expand-leave-active {
	transition: all var(--motion-moderate) var(--ease-spring);
	overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
	opacity: 0;
	max-height: 0;
}

.expand-enter-to,
.expand-leave-from {
	max-height: 1000px;
}
</style>
