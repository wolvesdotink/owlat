<script setup lang="ts">
import { trySplitZone, zoneRelativeHost } from '@owlat/shared';
import type { SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';

interface DNSRecord {
	type: string;
	host: string;
	/**
	 * True when `host` is an absolute FQDN (the return-path record's env hostname)
	 * rather than a name relative to `domain`. Supplied by `normalizeDnsRecord`;
	 * absent (→ relative) for the inline records the receiving / tracking sections
	 * build.
	 */
	hostIsFqdn?: boolean;
	/**
	 * MX preference. Verification enforces it exactly, so the panel shows + copies
	 * the full `<priority> <exchange>` value. Present only on MX records (supplied
	 * by `normalizeDnsRecord`).
	 */
	priority?: number;
	/**
	 * `null` when there is NO value to publish yet — a DKIM row whose key is
	 * minted at registration, or one the ESP supplies. The panel then says so
	 * instead of offering something copyable: an empty DKIM `p=` is not "blank",
	 * RFC 6376 §3.6.1 defines it as a REVOCATION, so publishing it would revoke
	 * the very selector the mail is about to be signed with.
	 */
	value: string | null;
}

interface VerificationResult {
	verified: boolean;
	message?: string;
	/** Human-readable reason the record did not verify (e.g. "No matching TXT record found"). */
	error?: string;
	/** The value actually found in DNS, so the user can compare found-vs-expected at a glance. */
	foundValue?: string;
}

interface Props {
	record: DNSRecord;
	label: string;
	domain: string;
	verification?: VerificationResult;
	/**
	 * SPF-only: when the domain already publishes a foreign SPF record, this
	 * carries the existing record and the single merged record to publish
	 * instead (RFC 7208 §3.2 allows only one `v=spf1` record per host).
	 */
	coexistence?: SpfCoexistenceSuggestion;
	/**
	 * What to say when there is no value to copy yet.
	 *
	 * The default is right for a key WE mint (adding the name produces it), and
	 * wrong for a key someone else holds — a relay's selector never resolves by
	 * creating the name, so telling the operator to "come back and copy the key"
	 * is an instruction that cannot work. The caller that knows why the row is
	 * pending is the one that gets to say so.
	 */
	pendingExplanation?: string;
	/**
	 * True when this record's NAME is not knowable yet.
	 *
	 * A DKIM row whose selector has not been minted — or is held by a relay and
	 * never will be by us — has no name to paste: the only string available is
	 * the bare `_domainkey.<subdomain>` PARENT, and a TXT record published there
	 * is at a name no verifier ever queries. Offering it as the primary paste
	 * target is worse than offering nothing, so the panel shows the parent as
	 * context and says what the real name will look like instead of handing over
	 * a copy button for a name that cannot work.
	 */
	hostNotYetKnown?: boolean;
}

const props = defineProps<Props>();

const { t } = useI18n();

const pendingCopy = computed<string>(
	() => props.pendingExplanation ?? t('components.domains.dnsRecordPanel.pendingValueDefault')
);

const { copy, isCopied } = useCopyToClipboard();

const handleCopyMerged = () => {
	if (props.coexistence) copy(props.coexistence.merged, `${props.label}-merged`);
};

/**
 * The record's fully-qualified name. `record.host` (see `normalizeDnsRecord`) is
 * either the apex marker `@`, a name RELATIVE to `domain`, or — when
 * `hostIsFqdn` is set — an absolute return-path `hostname` that may sit OUTSIDE
 * this domain's zone (a shared `bounces.owlat.com`). Honouring that flag instead
 * of guessing from the string is what stops the old `${host}.${domain}` rule from
 * doubling an absolute host into the classic `bounces.owlat.com.example.com`.
 */
const recordFqdn = computed<string>(() => {
	const host = props.record.host;
	if (host === '@') return props.domain;
	return props.record.hostIsFqdn ? host : `${host}.${props.domain}`;
});

interface HostDisplay {
	/** Primary copy target — the zone-relative name most DNS providers expect. */
	primary: string;
	/** The fully-qualified name to offer as a secondary copy, or null when the primary already is it. */
	fqdn: string | null;
	/** True when the record belongs to a different registrable zone than `domain`. */
	outOfZone: boolean;
	/** The registrable zone an out-of-zone record actually belongs to, for the note. */
	otherZone: string | null;
}

/**
 * Zone-aware host display (improvement plan §3.3). Primary = the name relative to
 * the domain's registrable zone (`s171._domainkey.mail`, or `@` at the apex);
 * secondary = the FQDN. When the record is NOT inside the domain's zone — the
 * env-derived shared return-path host is the real-world case — `zoneRelativeHost`
 * returns an absolute (trailing-dot) name; there is no single relative form to
 * paste, so we show the absolute host and name the zone it truly belongs to.
 *
 * Fail-soft: in dev / self-host a domain may have no registrable zone at all
 * (`localhost`, an internal TLD). Rather than throw in the template we fall back
 * to the plain FQDN with no zone-relative rewrite.
 */
const hostDisplay = computed<HostDisplay>(() => {
	const fqdn = recordFqdn.value;
	if (!trySplitZone(props.domain)) {
		return { primary: fqdn, fqdn: null, outOfZone: false, otherZone: null };
	}
	let relative: string;
	try {
		relative = zoneRelativeHost(fqdn, props.domain);
	} catch {
		return { primary: fqdn, fqdn: null, outOfZone: false, otherZone: null };
	}
	if (relative.endsWith('.')) {
		return {
			primary: fqdn,
			fqdn: null,
			outOfZone: true,
			otherZone: trySplitZone(fqdn)?.registrable ?? null,
		};
	}
	return { primary: relative, fqdn, outOfZone: false, otherZone: null };
});

/**
 * The name is fixed by an email standard (RFC-mandated label) and cannot be
 * customised — surfaced as a "Fixed by standard" pill. Keyed to the RFC service
 * labels: the underscore records (`_domainkey`, `_dmarc`, `_smtp._tls`,
 * `_mta-sts`) plus the RFC 8461 `mta-sts` policy CNAME. SPF / MX / mailFrom and
 * ordinary CNAMEs never carry it.
 */
const standardMandate = computed<{ rfc: string } | null>(() => {
	const name = recordFqdn.value.toLowerCase();
	const labelSet = new Set(name.split('.'));
	const rfcs = 'components.domains.dnsRecordPanel.rfc';
	if (labelSet.has('_domainkey')) return { rfc: t(`${rfcs}.dkim`) };
	if (labelSet.has('_dmarc')) return { rfc: t(`${rfcs}.dmarc`) };
	if (name.includes('_smtp._tls')) return { rfc: t(`${rfcs}.tlsReporting`) };
	if (labelSet.has('_mta-sts')) return { rfc: t(`${rfcs}.mtaSts`) };
	// RFC 8461 also mandates the `mta-sts` policy CNAME. Match the record's OWN
	// leftmost host label (not the composed FQDN) and require the CNAME type, so a
	// sending domain that merely begins with an `mta-sts.` label can't pill its
	// apex SPF/MX records.
	const ownLeftLabel = props.record.host.toLowerCase().split('.')[0];
	if (props.record.type === 'CNAME' && ownLeftLabel === 'mta-sts') {
		return { rfc: t(`${rfcs}.mtaSts`) };
	}
	return null;
});

const handleCopyHost = () => {
	copy(hostDisplay.value.primary, `${props.label}-host`);
};

const handleCopyFqdn = () => {
	if (hostDisplay.value.fqdn) copy(hostDisplay.value.fqdn, `${props.label}-fqdn`);
};

/**
 * What the user must publish in the record's value/data field. For an MX record
 * that carries a preference, verification enforces the priority EXACTLY, so the
 * shown + copied value is the full `<priority> <exchange>` (e.g. `10 mail.host`)
 * — what's enforced is what's shown. Every other record shows its value verbatim.
 */
const valueDisplay = computed<string | null>(() => {
	const { type, value, priority } = props.record;
	if (value === null) return null;
	return type === 'MX' && priority !== undefined ? `${priority} ${value}` : value;
});

const handleCopyValue = () => {
	const value = valueDisplay.value;
	if (value !== null) copy(value, `${props.label}-value`);
};

const handleCopyFound = () => {
	if (props.verification?.foundValue) {
		copy(props.verification.foundValue, `${props.label}-found`);
	}
};

/**
 * Show the found-vs-expected diagnostic only when we have a completed check
 * that did NOT verify and carries a reason. The happy path stays untouched.
 */
const diagnostic = computed(() => {
	const v = props.verification;
	if (!v || v.verified || !v.error) return null;
	return { error: v.error, foundValue: v.foundValue };
});
</script>

<template>
	<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
		<div class="flex items-center justify-between mb-2">
			<div class="flex items-center gap-2">
				<span class="px-2 py-0.5 bg-brand/20 text-brand text-xs font-medium rounded">
					{{ record.type }}
				</span>
				<span class="text-sm font-medium text-text-primary">
					{{ t('components.domains.dnsRecordPanel.recordHeading', { label }) }}
				</span>
				<span
					v-if="standardMandate"
					class="inline-flex items-center gap-1 px-2 py-0.5 bg-bg-deep text-text-tertiary text-xs font-medium rounded"
					:title="
						t('components.domains.dnsRecordPanel.standardPillTitle', { rfc: standardMandate.rfc })
					"
					data-testid="dns-standard-pill"
				>
					<Icon name="lucide:lock" class="w-3 h-3" />
					{{ t('components.domains.dnsRecordPanel.standardPill') }}
				</span>
			</div>
			<div
				v-if="verification"
				:class="[
					'flex items-center gap-1 text-xs',
					verification.verified ? 'text-success' : 'text-error',
				]"
			>
				<Icon
					:name="verification.verified ? 'lucide:check-circle-2' : 'lucide:x-circle'"
					class="w-3 h-3"
				/>
				{{
					verification.verified
						? t('components.domains.dnsRecordPanel.verified')
						: t('components.domains.dnsRecordPanel.notVerified')
				}}
			</div>
		</div>

		<div class="space-y-2">
			<!-- Host / Name — primary paste target is the name relative to the
			     registrable zone (§3.3); the full name is offered as a secondary
			     copy for providers that want the FQDN. -->
			<div>
				<p class="text-xs text-text-tertiary mb-1">
					{{ t('components.domains.dnsRecordPanel.hostName') }}
				</p>
				<!-- The name is not knowable yet: the only string we hold is the
				     `_domainkey` PARENT, and nothing queries a record published
				     there. Say what the real name will look like; offer no copy
				     button for a name that cannot work. -->
				<I18nT
					v-if="hostNotYetKnown"
					keypath="components.domains.dnsRecordPanel.hostNotYetKnown"
					tag="p"
					scope="global"
					class="rounded-lg border border-border-subtle bg-bg-deep px-3 py-2 text-xs text-text-tertiary"
					data-testid="dns-host-pending"
				>
					<template #name>
						<span class="font-mono">&lt;selector&gt;.{{ hostDisplay.primary }}</span>
					</template>
				</I18nT>
				<div v-else class="flex items-center gap-2">
					<code
						class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
						data-testid="dns-host-primary"
					>
						{{ hostDisplay.primary }}
					</code>
					<UiButton
						variant="ghost"
						class="p-2"
						:title="t('components.domains.dnsRecordPanel.copyHost')"
						@click="handleCopyHost"
					>
						<Icon
							v-if="isCopied(`${label}-host`)"
							name="lucide:check"
							class="w-4 h-4 text-success"
						/>
						<Icon v-else name="lucide:copy" class="w-4 h-4" />
					</UiButton>
				</div>

				<!-- Secondary: fully-qualified name + its own copy affordance. -->
				<div
					v-if="hostDisplay.fqdn && !hostNotYetKnown"
					class="mt-2"
					data-testid="dns-host-fqdn-row"
				>
					<p class="text-xs text-text-tertiary mb-1">
						{{ t('components.domains.dnsRecordPanel.fullName') }}
					</p>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 bg-bg-deep/60 px-3 py-1.5 rounded-lg text-xs text-text-tertiary font-mono break-all"
							data-testid="dns-host-fqdn"
						>
							{{ hostDisplay.fqdn }}
						</code>
						<UiButton
							variant="ghost"
							class="p-1.5"
							:title="t('components.domains.dnsRecordPanel.copyFullName')"
							@click="handleCopyFqdn"
						>
							<Icon
								v-if="isCopied(`${label}-fqdn`)"
								name="lucide:check"
								class="w-4 h-4 text-success"
							/>
							<Icon v-else name="lucide:copy" class="w-3.5 h-3.5" />
						</UiButton>
					</div>
					<p class="text-xs text-text-tertiary mt-1" data-testid="dns-provider-hint">
						{{ t('components.domains.dnsRecordPanel.providerHint') }}
					</p>
				</div>

				<!-- Out-of-zone: this record's name lives in a different DNS zone (a
				     shared return-path domain), so there is no zone-relative form to
				     paste here — show the absolute name and say where it belongs. -->
				<template v-if="hostDisplay.outOfZone && !hostNotYetKnown">
					<I18nT
						v-if="hostDisplay.otherZone"
						keypath="components.domains.dnsRecordPanel.outOfZoneNamed"
						tag="p"
						scope="global"
						class="text-xs text-text-tertiary mt-1"
						data-testid="dns-out-of-zone"
					>
						<template #zone>
							<span class="font-mono">{{ hostDisplay.otherZone }}</span>
						</template>
						<template #domain>{{ domain }}</template>
					</I18nT>
					<p v-else class="text-xs text-text-tertiary mt-1" data-testid="dns-out-of-zone">
						{{ t('components.domains.dnsRecordPanel.outOfZone', { domain }) }}
					</p>
				</template>
			</div>

			<!-- Value -->
			<div>
				<p class="text-xs text-text-tertiary mb-1">
					{{ t('components.domains.dnsRecordPanel.value') }}
				</p>
				<!-- No value yet: say so. Never render an empty DKIM p= as something
				     copyable — that is a published revocation, not a placeholder. -->
				<p
					v-if="valueDisplay === null"
					class="rounded-lg border border-border-subtle bg-bg-deep px-3 py-2 text-xs text-text-tertiary"
					data-testid="dns-value-pending"
				>
					{{ pendingCopy }}
				</p>
				<div v-else class="flex items-center gap-2">
					<code
						class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
						data-testid="dns-value"
					>
						{{ valueDisplay }}
					</code>
					<UiButton
						variant="ghost"
						class="p-2"
						:title="t('components.domains.dnsRecordPanel.copyValue')"
						@click="handleCopyValue"
					>
						<Icon
							v-if="isCopied(`${label}-value`)"
							name="lucide:check"
							class="w-4 h-4 text-success"
						/>
						<Icon v-else name="lucide:copy" class="w-4 h-4" />
					</UiButton>
				</div>
			</div>

			<!-- Verification diagnostic: the check ran but the record did not
			     verify. Surface the reason (and, when available, the value we
			     actually found) so the user can compare found-vs-expected
			     instead of just seeing a red "Not verified" pill. -->
			<div
				v-if="diagnostic"
				class="mt-3 rounded-lg border border-error/30 bg-error/10 p-3"
				data-testid="dns-diagnostic"
			>
				<p class="flex items-start gap-2 text-xs font-medium text-error">
					<Icon name="lucide:alert-circle" class="mt-0.5 w-3.5 h-3.5 shrink-0" />
					<span data-testid="dns-diagnostic-error">{{ diagnostic.error }}</span>
				</p>
				<div v-if="diagnostic.foundValue" class="mt-2">
					<p class="text-xs text-text-tertiary mb-1">
						{{ t('components.domains.dnsRecordPanel.found') }}
					</p>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-xs text-text-tertiary font-mono break-all line-clamp-2"
							:title="diagnostic.foundValue"
							data-testid="dns-diagnostic-found"
						>
							{{ diagnostic.foundValue }}
						</code>
						<UiButton
							variant="ghost"
							class="p-2"
							:title="t('components.domains.dnsRecordPanel.copyFoundValue')"
							@click="handleCopyFound"
						>
							<Icon
								v-if="isCopied(`${label}-found`)"
								name="lucide:check"
								class="w-4 h-4 text-success"
							/>
							<Icon v-else name="lucide:copy" class="w-4 h-4" />
						</UiButton>
					</div>
				</div>
			</div>

			<!-- SPF coexistence: a foreign SPF record already exists. Publishing a
			     second v=spf1 record is a PermError (RFC 7208 §3.2) that breaks SPF
			     for everyone, so offer a single merged record instead. -->
			<div v-if="coexistence" class="mt-3 rounded-lg border border-warning/30 bg-warning/10 p-3">
				<p class="flex items-start gap-2 text-xs font-medium text-warning">
					<Icon name="lucide:alert-triangle" class="mt-0.5 w-3.5 h-3.5 shrink-0" />
					<I18nT
						keypath="components.domains.dnsRecordPanel.coexistenceWarning"
						tag="span"
						scope="global"
					>
						<template #record>
							<code class="font-mono">v=spf1</code>
						</template>
					</I18nT>
				</p>
				<div class="mt-2">
					<p class="text-xs text-text-tertiary mb-1">
						{{ t('components.domains.dnsRecordPanel.existingRecord') }}
					</p>
					<code
						class="block bg-bg-deep px-3 py-2 rounded-lg text-xs text-text-tertiary font-mono break-all"
					>
						{{ coexistence.existing }}
					</code>
				</div>
				<div class="mt-2">
					<p class="text-xs text-text-tertiary mb-1">
						{{ t('components.domains.dnsRecordPanel.mergedRecord') }}
					</p>
					<div class="flex items-center gap-2">
						<code
							class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
						>
							{{ coexistence.merged }}
						</code>
						<UiButton
							variant="ghost"
							class="p-2"
							:title="t('components.domains.dnsRecordPanel.copyMergedValue')"
							@click="handleCopyMerged"
						>
							<Icon
								v-if="isCopied(`${label}-merged`)"
								name="lucide:check"
								class="w-4 h-4 text-success"
							/>
							<Icon v-else name="lucide:copy" class="w-4 h-4" />
						</UiButton>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
