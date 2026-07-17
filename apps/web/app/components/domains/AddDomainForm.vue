<script setup lang="ts">
/**
 * Guided Add-Domain form (the body of the "Add Sending Domain" modal).
 *
 * Two fields instead of one free-text box: the registrable **domain** the user
 * manages at their DNS provider, and a free-form **sending subdomain** with
 * quick-pick suggestions. The submitted value is still a single domain string
 * (`mail.example.com`) — no backend change — composed from the two fields.
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
 */
import { trySplitZone, isDnsLabel } from '@owlat/shared';
import { isFreemailDomain, resolveNs } from '~/utils/domainPrecheck';
import { useFormValidation, rules, type ValidationRule } from '~/composables/useFormValidation';

const props = defineProps<{
	/** True while the parent's create mutation is in flight. */
	loading?: boolean;
}>();

const emit = defineEmits<{
	/**
	 * The composed domain to register, plus an optional custom return-path
	 * (bounce) host. The page registers the domain first (create returns the new
	 * id) and then sets the return-path host via the D2 mutation, which needs
	 * that id — so both travel together and the page orchestrates.
	 */
	submit: [payload: { domain: string; returnPathHost: string | null }];
	cancel: [];
}>();

// Recommended sending subdomains — affordances, not an enum: the input stays
// free-form so "I already use mail. for webmail, give me post." is a one-click
// change and any other label is still accepted.
const SUBDOMAIN_SUGGESTIONS = ['mail', 'post', 'send'] as const;

// Field state. `sub` defaults to the recommended `mail` (keeps apex reputation
// separate); clearing it is the first-class "send from the apex" choice.
const domain = ref('');
const sub = ref('mail');
const nsUnresolved = ref(false);

// Advanced: an optional custom return-path (bounce) subdomain, collapsed by
// default so the common path stays a two-field form. The label composes to
// `<label>.<registrable zone>` (a sibling of the sending name), matching how the
// MTA keys the return-path SPF record.
const advancedOpen = ref(false);
const returnPathSub = ref('');
const normalizedReturnPathSub = computed(() => returnPathSub.value.trim().toLowerCase());

const normalizedDomain = computed(() => domain.value.trim().toLowerCase());
const normalizedSub = computed(() => sub.value.trim().toLowerCase());
const isApex = computed(() => normalizedSub.value === '');

// The single domain string the two fields compose to. Empty until a domain is
// entered, so the preview reads as an example rather than a stray `mail.`.
const combinedDomain = computed(() => {
	const base = normalizedDomain.value;
	if (!base) return '';
	return isApex.value ? base : `${normalizedSub.value}.${base}`;
});

// Freemail / NS checks apply to the registrable ZONE of the combined value —
// that is the zone the user must control. `mail.gmail.com`'s zone is still
// `gmail.com`, which they don't own, so the block must fire even though the
// combined string isn't itself a listed freemail domain. Fall back to the raw
// combined string while it has no registrable zone yet (mid-typing).
const registrableZone = computed(() => trySplitZone(combinedDomain.value)?.registrable ?? null);
const isFreemail = computed(() => isFreemailDomain(registrableZone.value ?? combinedDomain.value));

// A valid domain is one that has a registrable zone; the field also accepts a
// pasted full domain (`mail.example.com`), which `reflowDomain` normalizes.
const domainRule: ValidationRule = (value) => {
	const raw = String(value ?? '').trim();
	if (!raw) return true; // `required` owns the empty case
	return trySplitZone(raw) !== null || 'Enter a valid domain, like example.com';
};

// Subdomain is optional (empty = apex). When present, every label must be a
// real hostname label per the shared rule (rejects underscores, bad chars).
const subRule: ValidationRule = (value) => {
	const raw = String(value ?? '').trim();
	if (!raw) return true;
	const ok = raw
		.toLowerCase()
		.split('.')
		.every((label) => isDnsLabel(label));
	return ok || 'Use letters, digits and hyphens (e.g. mail or post)';
};

// Return-path subdomain: optional; a single hostname label when present.
const returnPathRule: ValidationRule = (value) => {
	const raw = String(value ?? '').trim();
	if (!raw) return true;
	return (
		isDnsLabel(raw.toLowerCase()) || 'Use a single label like bounce (letters, digits, hyphens)'
	);
};

const validation = useFormValidation({
	domain: [rules.required('Enter your domain'), domainRule],
	sub: [subRule],
	returnPath: [returnPathRule],
});

const domainError = computed(() => validation.getError('domain'));
const subError = computed(() => validation.getError('sub'));
const returnPathError = computed(() => validation.getError('returnPath'));

// The zone the return-path host lives in (a sibling of the sending name); falls
// back to the placeholder zone for the example preview before a domain is typed.
const returnPathZone = computed(() => registrableZone.value ?? 'example.com');
// The composed absolute return-path host emitted on submit — null when unset.
const returnPathHost = computed(() =>
	normalizedReturnPathSub.value && registrableZone.value
		? `${normalizedReturnPathSub.value}.${registrableZone.value}`
		: null
);
const showReturnPathPreview = computed(() => !validation.hasError('returnPath'));
const returnPathDescribedBy = computed(() => {
	if (returnPathError.value) return 'add-returnpath-error';
	return showReturnPathPreview.value ? 'add-returnpath-preview' : undefined;
});

// Only promise "you'll send as …" when the preview would be truthful: not a
// freemail domain (live), and no field currently carries a validation error.
// `hasError` reflects the last blur/submit — mirroring the B2 preview semantics
// — so a mid-typing value previews without a contradicting error beside it.
const showAddressPreview = computed(
	() => !isFreemail.value && !validation.hasError('domain') && !validation.hasError('sub')
);

// Wire each input to the guidance that describes it, so an AT user hears *what*
// is wrong / what they'll get — `aria-invalid` alone only says *that* something
// is wrong. The domain input points at its error (when present) and the preview
// (when shown); the subdomain input points at its error.
const domainDescribedBy = computed(() => {
	const ids: string[] = [];
	if (domainError.value) ids.push('add-domain-error');
	if (showAddressPreview.value) ids.push('add-domain-preview');
	return ids.length > 0 ? ids.join(' ') : undefined;
});
const subDescribedBy = computed(() => (subError.value ? 'add-domain-sub-error' : undefined));

// Pasting a full domain into the domain field reflows it into domain +
// subdomain. Sub labels from the paste WIN over the current subdomain — an
// explicit paste of `post.example.com` sets the sending subdomain to `post`.
function reflowDomain() {
	const split = trySplitZone(normalizedDomain.value);
	if (!split) return; // invalid — the domain rule explains it on blur
	domain.value = split.registrable;
	if (split.sub) sub.value = split.sub;
}

// An NS verdict belongs to the exact zone it was resolved for. Clear the
// advisory the moment the zone changes, so a live edit can't re-label the old
// warning with the newly-typed zone before the next blur re-checks it. (The
// in-flight lookup race is separately guarded by zone inside checkNs.)
watch(registrableZone, () => {
	nsUnresolved.value = false;
});

// Fail-soft NS advisory on the registrable zone (the name that actually
// delegates NS). Never blocks; a lookup error stays silent.
async function checkNs() {
	nsUnresolved.value = false;
	const zone = registrableZone.value;
	if (!zone || isFreemail.value) return;
	const resolves = await resolveNs(zone);
	// Ignore a stale response if the zone changed while the lookup was in flight.
	if (registrableZone.value === zone) nsUnresolved.value = resolves === false;
}

function handleDomainBlur() {
	reflowDomain();
	validation.touch('domain');
	validation.validateField('domain', domain.value);
	void checkNs();
}

function handleSubBlur() {
	validation.touch('sub');
	validation.validateField('sub', sub.value);
}

function handleReturnPathBlur() {
	validation.touch('returnPath');
	validation.validateField('returnPath', returnPathSub.value);
}

function chooseSubdomain(value: string) {
	sub.value = value;
	validation.touch('sub');
	validation.validateField('sub', value);
}

function onSubmit() {
	reflowDomain();
	validation.touch('domain');
	validation.touch('sub');
	validation.touch('returnPath');
	if (
		!validation.validate({
			domain: domain.value,
			sub: sub.value,
			returnPath: returnPathSub.value,
		})
	) {
		return;
	}
	if (isFreemail.value) return;
	emit('submit', { domain: combinedDomain.value, returnPathHost: returnPathHost.value });
}
</script>

<template>
	<form @submit.prevent="onSubmit">
		<div class="space-y-4">
			<!-- Your domain (registrable zone) -->
			<div>
				<label for="add-domain-name" class="label">
					Your domain <span class="text-error">*</span>
				</label>
				<input
					id="add-domain-name"
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
					@blur="handleDomainBlur"
				/>
				<p v-if="domainError" id="add-domain-error" class="mt-1 text-xs text-error">
					{{ domainError }}
				</p>
			</div>

			<!-- Sending subdomain (free-form, with suggestions) -->
			<div>
				<label for="add-domain-sub" class="label">
					Subdomain for sending
					<span class="font-normal text-text-tertiary">
						— recommended, keeps your apex reputation separate</span
					>
				</label>
				<input
					id="add-domain-sub"
					v-model="sub"
					type="text"
					placeholder="mail"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					:class="['input', subError && 'input-error']"
					:disabled="loading"
					:aria-invalid="subError ? 'true' : undefined"
					:aria-describedby="subDescribedBy"
					@blur="handleSubBlur"
				/>
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<span class="text-xs text-text-tertiary">Choose:</span>
					<button
						v-for="suggestion in SUBDOMAIN_SUGGESTIONS"
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
				<p v-if="subError" id="add-domain-sub-error" class="mt-1 text-xs text-error">
					{{ subError }}
				</p>
			</div>

			<!-- Live "you'll send as …" preview. Suppressed on a freemail block or a
			     validation error (a preview would contradict the message that owns the
			     field); an empty domain reads as an explicit example, not a promise.
			     Wired to the domain input via aria-describedby so it is announced. -->
			<p
				v-if="showAddressPreview"
				id="add-domain-preview"
				class="text-xs text-text-secondary"
				data-testid="address-preview"
			>
				<template v-if="combinedDomain">
					You'll send as
					<strong class="text-text-primary">you@{{ combinedDomain }}</strong>
				</template>
				<template v-else>
					For example, you'll send as
					<span class="font-medium text-text-primary">you@mail.example.com</span>
				</template>
			</p>

			<!-- Apex trade-off: sending from the registrable apex is first-class, but
			     it shares reputation and needs any existing SPF merged. We only name
			     the trade-off here; the DNS record panel owns the actual merged-record
			     UI (SPF coexistence), so we don't duplicate it. -->
			<div
				v-if="isApex && registrableZone && !isFreemail"
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
			     default so the common two-field path stays simple. -->
			<div>
				<button
					type="button"
					class="flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
					:aria-expanded="advancedOpen"
					aria-controls="add-domain-advanced"
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
					id="add-domain-advanced"
					class="mt-3 rounded-lg border border-border-subtle bg-bg-surface p-3"
					data-testid="advanced-section"
				>
					<label for="add-returnpath" class="label">
						Bounce (return-path) subdomain
						<span class="font-normal text-text-tertiary">— optional</span>
					</label>
					<input
						id="add-returnpath"
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
						@blur="handleReturnPathBlur"
					/>
					<p v-if="returnPathError" id="add-returnpath-error" class="mt-1 text-xs text-error">
						{{ returnPathError }}
					</p>
					<!-- Live preview, same discipline as the sending address: suppressed on
					     error, empty state framed as an example not a promise. -->
					<p
						v-if="showReturnPathPreview"
						id="add-returnpath-preview"
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
				{{ loading ? 'Adding...' : 'Add Domain' }}
			</button>
		</div>
	</form>
</template>
