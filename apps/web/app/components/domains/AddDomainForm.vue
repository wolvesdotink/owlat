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
	suggestions: () => ['mail', 'post', 'send'],
	defaultSubdomain: 'mail',
	subdomainLabel: 'Subdomain for sending',
	subdomainHint: '— recommended, keeps your apex reputation separate',
	subdomainPlaceholder: 'mail',
	blockFreemail: true,
	showApexNote: true,
	submitLabel: 'Add Domain',
});

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
} = useAddDomainForm(props, (payload) => emit('submit', payload));
</script>

<template>
	<form @submit.prevent="onSubmit">
		<div class="space-y-4">
			<!-- Your domain (registrable zone) -->
			<div>
				<label :for="domainInputId" class="label">
					Your domain <span class="text-error">*</span>
				</label>
				<input
					:id="domainInputId"
					v-model="domain"
					type="text"
					placeholder="example.com"
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
					{{ subdomainLabel }}
					<span v-if="subdomainHint" class="font-normal text-text-tertiary">
						{{ subdomainHint }}</span
					>
				</label>
				<input
					:id="subInputId"
					v-model="sub"
					type="text"
					:placeholder="subdomainPlaceholder"
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
					<span class="text-xs text-text-tertiary">Choose:</span>
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
						none (use apex)
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
					<template v-if="combinedDomain">
						Your tracking links will use
						<strong class="text-text-primary">{{ combinedDomain }}</strong>
					</template>
					<template v-else>
						For example, your tracking links will use
						<span class="font-medium text-text-primary">links.example.com</span>
					</template>
				</template>
				<template v-else>
					<template v-if="combinedDomain">
						You'll send as
						<strong class="text-text-primary">you@{{ combinedDomain }}</strong>
					</template>
					<template v-else>
						For example, you'll send as
						<span class="font-medium text-text-primary">you@mail.example.com</span>
					</template>
				</template>
			</p>

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
					<span>
						Sending from your apex
						<strong class="text-text-primary">{{ registrableZone }}</strong> shares its sending
						reputation with everything else that sends from it, and any SPF record it already
						publishes must be merged into one. When you verify, Owlat shows the single merged record
						to publish.
					</span>
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
					Advanced
				</button>

				<div
					v-if="advancedOpen"
					:id="advancedPanelId"
					class="mt-3 rounded-lg border border-border-subtle bg-bg-surface p-3"
					data-testid="advanced-section"
				>
					<label :for="returnPathInputId" class="label">
						Bounce (return-path) subdomain
						<span class="font-normal text-text-tertiary">— optional</span>
					</label>
					<input
						:id="returnPathInputId"
						v-model="returnPathSub"
						type="text"
						placeholder="bounce"
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
						<template v-if="normalizedReturnPathSub">
							Bounces will come from
							<strong class="text-text-primary"
								>{{ normalizedReturnPathSub }}.{{ returnPathZone }}</strong
							>
						</template>
						<template v-else>
							For example, bounces would come from
							<span class="font-medium text-text-primary">bounce.{{ returnPathZone }}</span>
						</template>
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
				<p class="text-xs text-text-secondary">
					You can't publish DNS records for
					<strong class="text-text-primary">{{ registrableZone ?? combinedDomain }}</strong>
					— it's a shared mailbox provider you don't control. Use a domain you own, or
					<NuxtLink to="/dashboard/postbox/migrate" class="text-brand hover:underline font-medium"
						>connect an external mailbox</NuxtLink
					>
					instead.
				</p>
			</div>

			<!-- Advisory: the domain doesn't resolve (likely a typo). Submit still allowed. -->
			<div
				v-else-if="nsUnresolved"
				class="rounded-lg border border-warning/20 bg-warning/5 p-3 flex items-start gap-2.5"
				data-testid="ns-warning"
			>
				<Icon name="lucide:alert-triangle" class="w-4 h-4 text-warning shrink-0 mt-0.5" />
				<p class="text-xs text-text-secondary">
					We couldn't find any nameservers for
					<strong class="text-text-primary">{{ registrableZone }}</strong>
					— double-check the spelling. You can still add it if the domain is brand new and its DNS
					is still being set up.
				</p>
			</div>
		</div>

		<div class="flex justify-end gap-3 mt-6">
			<button type="button" class="btn btn-secondary" :disabled="loading" @click="emit('cancel')">
				Cancel
			</button>
			<button type="submit" class="btn btn-primary gap-2" :disabled="loading || isFreemail">
				<Icon v-if="loading" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				<Icon v-else name="lucide:plus" class="w-4 h-4" />
				{{ loading ? 'Adding...' : submitLabel }}
			</button>
		</div>
	</form>
</template>
