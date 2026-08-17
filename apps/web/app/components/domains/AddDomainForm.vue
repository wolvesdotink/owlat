<script setup lang="ts">
/**
 * Guided Add-Domain form — the shared body of BOTH the "Add Sending Domain"
 * modal and the "Add Tracking Domain" modal. ONE component, parameterized by
 * props (the `context` discriminator plus copy/behaviour overrides) rather than
 * forked, so the two flows can't drift.
 *
 * Two fields instead of one free-text box: the registrable **domain** the user
 * manages at their DNS provider, and a free-form **subdomain** with quick-pick
 * suggestions. The submitted value is still a single domain string
 * (`mail.example.com` / `track.example.com`) — no backend change — composed from
 * the two fields.
 *
 * Zone math (split / compose / label validation) goes through the shared
 * `@owlat/shared` PSL module so the client and the Convex verifier agree on the
 * registrable zone; we never hand-roll "last two labels" here. Pasting a full
 * domain into the domain field is reflowed back into domain + subdomain via
 * `trySplitZone`, so `mail.example.co.uk` round-trips to `example.co.uk` + `mail`.
 *
 * An "Advanced" disclosure (collapsed by default) adds an optional custom
 * return-path (bounce) subdomain. It composes to a sibling host of the sending
 * name; the value rides the submit payload so the page can set it (via the D2
 * mutation) right after registration, which is when the new domain id exists.
 * The return path is a sending-only concern, so the whole disclosure is gated on
 * `context === 'sending'` — the tracking context (no return path) suppresses it.
 */
import {
	useAddDomainForm,
	type AddDomainFormProps,
	type AddDomainSubmitPayload,
} from '~/composables/useAddDomainForm';

const props = withDefaults(defineProps<AddDomainFormProps>(), {
	loading: false,
	context: 'sending',
	// `mail` and `news` FIRST, because the layout we recommend is one name per
	// stream (see the note in the template): transactional on `mail.`, campaigns
	// and lifecycle on `news.`.
	suggestions: () => ['mail', 'news', 'post', 'send'],
	defaultSubdomain: 'mail',
	blockFreemail: true,
	showApexNote: true,
});

const { t } = useI18n();

// The four copy props have no static default any more: a `withDefaults` default
// is hoisted out of `setup()`, so it cannot read `t`. They fall back here
// instead, which is also what keeps the default copy following the active locale.
const subdomainLabelText = computed(
	() => props.subdomainLabel ?? t('components.domains.addDomainForm.subdomainLabel')
);
const subdomainHintText = computed(
	() => props.subdomainHint ?? t('components.domains.addDomainForm.subdomainHint')
);
const subdomainPlaceholderText = computed(
	() => props.subdomainPlaceholder ?? t('components.domains.addDomainForm.subdomainPlaceholder')
);
const submitLabelText = computed(
	() => props.submitLabel ?? t('components.domains.addDomainForm.submitLabel')
);

const emit = defineEmits<{
	/**
	 * The composed domain to register, plus an optional custom return-path
	 * (bounce) host. The page registers the domain first (create returns the new
	 * id) and then sets the return-path host via the D2 mutation, which needs
	 * that id — so both travel together and the page orchestrates.
	 */
	submit: [payload: AddDomainSubmitPayload];
	cancel: [];
}>();

// All the field state / zone math / validation lives in the composable so this
// SFC stays a thin template binding (and under the file-size ratchet).
const {
	domain,
	sub,
	nsUnresolved,
	advancedOpen,
	returnPathSub,
	normalizedSub,
	normalizedReturnPathSub,
	isApex,
	combinedDomain,
	registrableZone,
	isFreemail,
	returnPathZone,
	domainError,
	subError,
	returnPathError,
	showAddressPreview,
	showReturnPathPreview,
	domainInputId,
	subInputId,
	domainErrorId,
	subErrorId,
	previewId,
	advancedPanelId,
	returnPathInputId,
	returnPathErrorId,
	returnPathPreviewId,
	domainDescribedBy,
	subDescribedBy,
	returnPathDescribedBy,
	handleDomainBlur,
	handleSubBlur,
	handleReturnPathBlur,
	chooseSubdomain,
	onSubmit,
	// The composable only reads the behavioural props (all of which still carry a
	// static default); the copy props it never touches are resolved above.
} = useAddDomainForm(props as Required<AddDomainFormProps>, (payload) => emit('submit', payload));
</script>

<template>
	<form @submit.prevent="onSubmit">
		<div class="space-y-4">
			<!-- Your domain (registrable zone) -->
			<div>
				<label :for="domainInputId" class="label">
					{{ t('components.domains.addDomainForm.domainLabel') }}
					<span class="text-error">*</span>
				</label>
				<input
					:id="domainInputId"
					v-model="domain"
					type="text"
					:placeholder="t('components.domains.addDomainForm.domainPlaceholder')"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					:class="['input', domainError && 'input-error']"
					:disabled="loading"
					:aria-invalid="domainError ? 'true' : undefined"
					:aria-describedby="domainDescribedBy"
					data-testid="domain-input"
					@blur="handleDomainBlur"
				/>
				<p
					v-if="domainError"
					:id="domainErrorId"
					class="mt-1 text-xs text-error"
					data-testid="domain-error"
				>
					{{ domainError }}
				</p>
			</div>

			<!-- Sending subdomain (free-form, with suggestions) -->
			<div>
				<label :for="subInputId" class="label">
					{{ subdomainLabelText }}
					<span v-if="subdomainHintText" class="font-normal text-text-tertiary">
						{{ subdomainHintText }}</span
					>
				</label>
				<input
					:id="subInputId"
					v-model="sub"
					type="text"
					:placeholder="subdomainPlaceholderText"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					:class="['input', subError && 'input-error']"
					:disabled="loading"
					:aria-invalid="subError ? 'true' : undefined"
					:aria-describedby="subDescribedBy"
					data-testid="sub-input"
					@blur="handleSubBlur"
				/>
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<span class="text-xs text-text-tertiary">
						{{ t('components.domains.addDomainForm.choose') }}
					</span>
					<button
						v-for="suggestion in suggestions"
						:key="suggestion"
						type="button"
						class="rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
						:class="
							normalizedSub === suggestion
								? 'border-brand bg-brand/10 text-brand'
								: 'border-border-subtle text-text-secondary hover:bg-bg-surface-hover'
						"
						:aria-pressed="normalizedSub === suggestion"
						:disabled="loading"
						@click="chooseSubdomain(suggestion)"
					>
						{{ suggestion }}
					</button>
					<button
						type="button"
						class="rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
						:class="
							isApex
								? 'border-brand bg-brand/10 text-brand'
								: 'border-border-subtle text-text-secondary hover:bg-bg-surface-hover'
						"
						:aria-pressed="isApex"
						:disabled="loading"
						@click="chooseSubdomain('')"
					>
						{{ t('components.domains.addDomainForm.useApex') }}
					</button>
				</div>
				<p v-if="subError" :id="subErrorId" class="mt-1 text-xs text-error" data-testid="sub-error">
					{{ subError }}
				</p>
			</div>

			<!-- Live "you'll send as …" preview. Suppressed on a freemail block or a
			     validation error (a preview would contradict the message that owns the
			     field); an empty domain reads as an explicit example, not a promise.
			     Wired to the domain input via aria-describedby so it is announced. -->
			<p
				v-if="showAddressPreview"
				:id="previewId"
				class="text-xs text-text-secondary"
				data-testid="address-preview"
			>
				<!-- Sending: the address you'll send as. Tracking: the branded host your
				     links will point at. Both compose from the same two fields via A1. -->
				<template v-if="context === 'tracking'">
					<I18nT
						v-if="combinedDomain"
						keypath="components.domains.addDomainForm.trackingPreview"
						tag="span"
						scope="global"
					>
						<template #host>
							<strong class="text-text-primary">{{ combinedDomain }}</strong>
						</template>
					</I18nT>
					<I18nT
						v-else
						keypath="components.domains.addDomainForm.trackingPreviewExample"
						tag="span"
						scope="global"
					>
						<template #host>
							<span class="font-medium text-text-primary">
								{{ t('components.domains.addDomainForm.trackingExampleHost') }}
							</span>
						</template>
					</I18nT>
				</template>
				<template v-else>
					<I18nT
						v-if="combinedDomain"
						keypath="components.domains.addDomainForm.sendingPreview"
						tag="span"
						scope="global"
					>
						<template #address>
							<strong class="text-text-primary">you@{{ combinedDomain }}</strong>
						</template>
					</I18nT>
					<I18nT
						v-else
						keypath="components.domains.addDomainForm.sendingPreviewExample"
						tag="span"
						scope="global"
					>
						<template #address>
							<span class="font-medium text-text-primary">
								{{ t('components.domains.addDomainForm.sendingExampleAddress') }}
							</span>
						</template>
					</I18nT>
				</template>
			</p>

			<!-- Per-STREAM subdomains (G-14). Domain reputation is evaluated per name
			     and does NOT inherit from the root, so one name per kind of mail is
			     what keeps a bad campaign away from password resets. Said here, in
			     the wizard, rather than in the docs — and stated as the recommended
			     layout rather than an expert option. Sending-only. -->
			<div
				v-if="context === 'sending'"
				class="rounded-lg border border-border-subtle bg-bg-surface p-3"
				data-testid="stream-subdomain-note"
			>
				<p class="flex items-start gap-2 text-xs text-text-secondary">
					<Icon name="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
					<I18nT
						keypath="components.domains.addDomainForm.streamNote"
						tag="span"
						scope="global"
					>
						<template #transactionalName>
							<strong class="text-text-primary">mail.</strong>
						</template>
						<template #bulkName>
							<strong class="text-text-primary">news.</strong>
						</template>
					</I18nT>
				</p>
			</div>

			<!-- Apex trade-off: sending from the registrable apex is first-class, but
			     it shares reputation and needs any existing SPF merged. We only name
			     the trade-off here; the DNS record panel owns the actual merged-record
			     UI (SPF coexistence), so we don't duplicate it. -->
			<div
				v-if="showApexNote && isApex && registrableZone && !isFreemail"
				class="rounded-lg border border-border-subtle bg-bg-surface p-3"
				data-testid="apex-note"
			>
				<p class="flex items-start gap-2 text-xs text-text-secondary">
					<Icon name="lucide:info" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
					<I18nT keypath="components.domains.addDomainForm.apexNote" tag="span" scope="global">
						<template #zone>
							<strong class="text-text-primary">{{ registrableZone }}</strong>
						</template>
					</I18nT>
				</p>
			</div>

			<!-- Advanced: optional custom return-path (bounce) host. Collapsed by
			     default so the common two-field path stays simple. Sending-only — the
			     tracking context has no return path, so the whole disclosure is hidden. -->
			<div v-if="context === 'sending'" data-testid="advanced">
				<button
					type="button"
					class="flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
					:aria-expanded="advancedOpen"
					:aria-controls="advancedPanelId"
					data-testid="advanced-toggle"
					:disabled="loading"
					@click="advancedOpen = !advancedOpen"
				>
					<Icon
						name="lucide:chevron-right"
						class="h-3.5 w-3.5 transition-transform"
						:class="advancedOpen ? 'rotate-90' : ''"
					/>
					{{ t('components.domains.addDomainForm.advanced') }}
				</button>

				<div
					v-if="advancedOpen"
					:id="advancedPanelId"
					class="mt-3 rounded-lg border border-border-subtle bg-bg-surface p-3"
					data-testid="advanced-section"
				>
					<label :for="returnPathInputId" class="label">
						{{ t('components.domains.addDomainForm.returnPathLabel') }}
						<span class="font-normal text-text-tertiary">
							{{ t('components.domains.addDomainForm.returnPathOptional') }}
						</span>
					</label>
					<input
						:id="returnPathInputId"
						v-model="returnPathSub"
						type="text"
						:placeholder="t('components.domains.addDomainForm.returnPathPlaceholder')"
						autocapitalize="off"
						autocorrect="off"
						spellcheck="false"
						:class="['input', returnPathError && 'input-error']"
						:disabled="loading"
						:aria-invalid="returnPathError ? 'true' : undefined"
						:aria-describedby="returnPathDescribedBy"
						data-testid="returnpath-input"
						@blur="handleReturnPathBlur"
					/>
					<p
						v-if="returnPathError"
						:id="returnPathErrorId"
						class="mt-1 text-xs text-error"
						data-testid="returnpath-error"
					>
						{{ returnPathError }}
					</p>
					<!-- Live preview, same discipline as the sending address: suppressed on
					     error, empty state framed as an example not a promise. -->
					<p
						v-if="showReturnPathPreview"
						:id="returnPathPreviewId"
						class="mt-1 text-xs text-text-secondary"
						data-testid="returnpath-preview"
					>
						<I18nT
							v-if="normalizedReturnPathSub"
							keypath="components.domains.addDomainForm.returnPathPreview"
							tag="span"
							scope="global"
						>
							<template #host>
								<strong class="text-text-primary"
									>{{ normalizedReturnPathSub }}.{{ returnPathZone }}</strong
								>
							</template>
						</I18nT>
						<I18nT
							v-else
							keypath="components.domains.addDomainForm.returnPathPreviewExample"
							tag="span"
							scope="global"
						>
							<template #host>
								<span class="font-medium text-text-primary">bounce.{{ returnPathZone }}</span>
							</template>
						</I18nT>
					</p>
				</div>
			</div>

			<!-- Blocking: freemail / public-mailbox domain the user can't publish DNS for. -->
			<div
				v-if="isFreemail"
				class="rounded-lg border border-error/20 bg-error/5 p-3 flex items-start gap-2.5"
				data-testid="freemail-warning"
			>
				<Icon name="lucide:shield-alert" class="w-4 h-4 text-error shrink-0 mt-0.5" />
				<I18nT
					keypath="components.domains.addDomainForm.freemailWarning"
					tag="p"
					scope="global"
					class="text-xs text-text-secondary"
				>
					<template #zone>
						<strong class="text-text-primary">{{ registrableZone ?? combinedDomain }}</strong>
					</template>
					<template #migrateLink>
						<NuxtLink to="/dashboard/postbox/migrate" class="text-brand hover:underline font-medium">
							{{ t('components.domains.addDomainForm.freemailMigrateLink') }}
						</NuxtLink>
					</template>
				</I18nT>
			</div>

			<!-- Advisory: the domain doesn't resolve (likely a typo). Submit still allowed. -->
			<div
				v-else-if="nsUnresolved"
				class="rounded-lg border border-warning/20 bg-warning/5 p-3 flex items-start gap-2.5"
				data-testid="ns-warning"
			>
				<Icon name="lucide:alert-triangle" class="w-4 h-4 text-warning shrink-0 mt-0.5" />
				<I18nT
					keypath="components.domains.addDomainForm.nsWarning"
					tag="p"
					scope="global"
					class="text-xs text-text-secondary"
				>
					<template #zone>
						<strong class="text-text-primary">{{ registrableZone }}</strong>
					</template>
				</I18nT>
			</div>
		</div>

		<div class="flex justify-end gap-3 mt-6">
			<UiButton variant="secondary" type="button" :disabled="loading" @click="emit('cancel')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="submit" class="gap-2" :disabled="loading || isFreemail">
				<Icon v-if="loading" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				<Icon v-else name="lucide:plus" class="w-4 h-4" />
				{{ loading ? t('components.domains.addDomainForm.adding') : submitLabelText }}
			</UiButton>
		</div>
	</form>
</template>
