<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();

// Getters: `useSeoMeta` captures its options once, so a plain `t()` would pin
// the title to the locale that was active at setup.
useSeoMeta({
	title: () => t('seo.waitlist.title'),
	ogTitle: () => t('seo.waitlist.title'),
	description: () => t('seo.waitlist.description'),
	robots: 'noindex',
});

const config = useRuntimeConfig();
const waitlistEndpoint = (config.public.waitlistEndpoint as string) || '';

type FormState = 'idle' | 'submitting' | 'success' | 'error';

const state = ref<FormState>('idle');
const email = ref('');
const name = ref('');
const company = ref('');
const volume = ref('');
const errorMessage = ref('');
// Set when the error is about the address itself, so the field is marked too.
const emailInvalid = ref(false);
const successHeading = ref<HTMLElement | null>(null);

// The form is swapped for the success card, which would drop focus to <body>;
// moving it to the card's heading tells keyboard and screen-reader users what
// happened.
watch(state, async (next) => {
	if (next !== 'success') return;
	await nextTick();
	successHeading.value?.focus();
});

// The submitted `value` is the machine-readable bucket and never changes with
// the locale; only its label is translated.
const volumeOptions = [
	{ value: '', labelKey: 'waitlist.volume.none' },
	{ value: '<10k', labelKey: 'waitlist.volume.under10k' },
	{ value: '10k-100k', labelKey: 'waitlist.volume.to100k' },
	{ value: '100k-1m', labelKey: 'waitlist.volume.to1m' },
	{ value: '>1m', labelKey: 'waitlist.volume.over1m' },
];

async function submit(e: Event) {
	e.preventDefault();
	if (state.value === 'submitting') return;

	// Minimal client-side validation
	const emailTrimmed = email.value.trim();
	if (!emailTrimmed || !emailTrimmed.includes('@')) {
		state.value = 'error';
		emailInvalid.value = true;
		errorMessage.value = t('waitlist.errors.invalidEmail');
		return;
	}

	state.value = 'submitting';
	emailInvalid.value = false;
	errorMessage.value = '';

	const payload = {
		email: emailTrimmed,
		name: name.value.trim(),
		company: company.value.trim(),
		volume: volume.value,
		source: 'marketing/waitlist',
		submittedAt: new Date().toISOString(),
	};

	// Real deployments set NUXT_PUBLIC_WAITLIST_ENDPOINT to the nest-api HTTP
	// route. Without it nothing is stored, so only a dev server may pretend the
	// signup worked: a production build must not tell a visitor they are on a
	// list that does not exist.
	if (!waitlistEndpoint) {
		if (import.meta.dev) {
			console.info('[waitlist] No endpoint configured; would submit:', payload);
			state.value = 'success';
		} else {
			state.value = 'error';
			errorMessage.value = t('waitlist.errors.generic');
		}
		return;
	}

	try {
		const res = await fetch(waitlistEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		state.value = 'success';
	} catch (err) {
		// The browser's own message ("Failed to fetch") is English and
		// meaningless to a visitor; it goes to the console, the visitor gets copy.
		console.warn('[waitlist] signup failed:', err);
		state.value = 'error';
		errorMessage.value = t('waitlist.errors.generic');
	}
}
</script>

<template>
	<section
		class="relative min-h-[100dvh] flex items-center overflow-hidden py-32 max-md:py-20 px-8 max-md:px-6"
	>
		<div class="relative w-full max-w-[560px] mx-auto">
			<!-- Eyebrow -->
			<span class="lp-eyebrow mb-4">{{ t('waitlist.eyebrow') }}</span>

			<I18nT
				keypath="waitlist.title"
				tag="h1"
				class="text-[clamp(2.2rem,4.5vw,3.25rem)] font-medium leading-[1.1] tracking-[-0.02em] text-text-primary mb-5"
				scope="global"
			>
				<template #accent>
					<span class="lp-title-accent">{{ t('waitlist.titleAccent') }}</span>
				</template>
			</I18nT>

			<I18nT
				keypath="waitlist.intro"
				tag="p"
				class="text-[1.0625rem] text-text-secondary leading-[1.65] mb-8"
				scope="global"
			>
				<template #link>
					<a
						href="https://docs.owlat.app/developer/self-hosting"
						class="text-brand hover:underline"
					>
						{{ t('waitlist.introLink') }}
					</a>
				</template>
			</I18nT>

			<!-- Form / Success states -->
			<template v-if="state !== 'success'">
				<form class="lp-card p-8 max-sm:p-6 space-y-4" @submit="submit">
					<div>
						<label for="wl-email" class="label"
							>{{ t('waitlist.emailLabel') }} <span class="text-brand">*</span></label
						>
						<input
							id="wl-email"
							v-model="email"
							type="email"
							required
							autocomplete="email"
							:placeholder="t('waitlist.emailPlaceholder')"
							class="input w-full"
							:class="emailInvalid ? 'input-error' : ''"
							:aria-invalid="emailInvalid ? 'true' : undefined"
							:aria-describedby="state === 'error' ? 'wl-error' : undefined"
						/>
					</div>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<div>
							<label for="wl-name" class="label">{{ t('waitlist.nameLabel') }}</label>
							<input
								id="wl-name"
								v-model="name"
								type="text"
								autocomplete="name"
								class="input w-full"
							/>
						</div>

						<div>
							<label for="wl-company" class="label">{{ t('waitlist.companyLabel') }}</label>
							<input
								id="wl-company"
								v-model="company"
								type="text"
								autocomplete="organization"
								class="input w-full"
							/>
						</div>
					</div>

					<div>
						<label for="wl-volume" class="label">{{ t('waitlist.volumeLabel') }}</label>
						<select id="wl-volume" v-model="volume" class="input w-full">
							<option v-for="opt in volumeOptions" :key="opt.value" :value="opt.value">
								{{ t(opt.labelKey) }}
							</option>
						</select>
					</div>

					<div
						v-if="state === 'error'"
						id="wl-error"
						role="alert"
						class="rounded-lg border border-error/40 bg-error/5 px-4 py-3 text-[0.8125rem] text-error"
					>
						{{ errorMessage }}
					</div>

					<button
						type="submit"
						:disabled="state === 'submitting'"
						class="btn btn-primary group w-full px-7 text-md"
					>
						<span>{{
							state === 'submitting' ? t('waitlist.submitting') : t('waitlist.submit')
						}}</span>
						<svg
							v-if="state !== 'submitting'"
							aria-hidden="true"
							class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M5 12h14" />
							<path d="m12 5 7 7-7 7" />
						</svg>
					</button>

					<p class="text-[0.75rem] text-text-tertiary text-center mt-2">
						{{ t('waitlist.disclaimer') }}
					</p>
				</form>
			</template>

			<!-- Success state -->
			<template v-else>
				<div class="lp-card p-8 text-center">
					<svg
						aria-hidden="true"
						class="mx-auto w-10 h-10 text-success mb-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
						<path d="m9 11 3 3L22 4" />
					</svg>
					<h2
						ref="successHeading"
						tabindex="-1"
						class="font-display text-2xl text-text-primary mb-2 focus:outline-none"
					>
						{{ t('waitlist.success.title') }}
					</h2>
					<I18nT
						keypath="waitlist.success.body"
						tag="p"
						class="text-[0.9375rem] text-text-secondary leading-relaxed mb-6"
						scope="global"
					>
						<template #link>
							<a
								href="https://docs.owlat.app/developer/self-hosting"
								class="text-brand hover:underline"
							>
								{{ t('waitlist.success.bodyLink') }}
							</a>
						</template>
					</I18nT>
					<a :href="localePath('/')" class="btn btn-hairline btn-sm no-underline">
						{{ t('waitlist.success.back') }}
					</a>
				</div>
			</template>
		</div>
	</section>
</template>
