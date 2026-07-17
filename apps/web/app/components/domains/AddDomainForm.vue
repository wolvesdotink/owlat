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
 * D3 will add an "Advanced" return-path section below the subdomain field — it
 * is a sibling addition to this layout, not a rework.
 */
import { trySplitZone, isDnsLabel } from '@owlat/shared';
import { isFreemailDomain, resolveNs } from '~/utils/domainPrecheck';
import { useFormValidation, rules, type ValidationRule } from '~/composables/useFormValidation';

const props = defineProps<{
	/** True while the parent's create mutation is in flight. */
	loading?: boolean;
}>();

const emit = defineEmits<{
	/** The composed, normalized single domain string to register. */
	submit: [domain: string];
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

const validation = useFormValidation({
	domain: [rules.required('Enter your domain'), domainRule],
	sub: [subRule],
});

const domainError = computed(() => validation.getError('domain'));
const subError = computed(() => validation.getError('sub'));

// Only promise "you'll send as …" when the preview would be truthful: not a
// freemail domain (live), and no field currently carries a validation error.
// `hasError` reflects the last blur/submit — mirroring the B2 preview semantics
// — so a mid-typing value previews without a contradicting error beside it.
const showAddressPreview = computed(
	() => !isFreemail.value && !validation.hasError('domain') && !validation.hasError('sub')
);

// Pasting a full domain into the domain field reflows it into domain +
// subdomain. Sub labels from the paste WIN over the current subdomain — an
// explicit paste of `post.example.com` sets the sending subdomain to `post`.
function reflowDomain() {
	const split = trySplitZone(normalizedDomain.value);
	if (!split) return; // invalid — the domain rule explains it on blur
	domain.value = split.registrable;
	if (split.sub) sub.value = split.sub;
}

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

function chooseSubdomain(value: string) {
	sub.value = value;
	validation.touch('sub');
	validation.validateField('sub', value);
}

function onSubmit() {
	reflowDomain();
	validation.touch('domain');
	validation.touch('sub');
	if (!validation.validate({ domain: domain.value, sub: sub.value })) return;
	if (isFreemail.value) return;
	emit('submit', combinedDomain.value);
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
					:aria-describedby="showAddressPreview ? 'add-domain-preview' : undefined"
					@blur="handleDomainBlur"
				/>
				<p v-if="domainError" class="mt-1 text-xs text-error">{{ domainError }}</p>
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
				<p v-if="subError" class="mt-1 text-xs text-error">{{ subError }}</p>
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
