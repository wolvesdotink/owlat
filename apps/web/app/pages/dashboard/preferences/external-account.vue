<script setup lang="ts">
/**
 * Settings → Connected mailboxes.
 *
 * This route used to redirect into the import wizard, which meant the only
 * place to end a connection was a screen you reach to START one — and only
 * before the first import. Now it is where the connection lives: what is
 * connected, how it is doing, and how to change the password, disconnect, or
 * delete it. Connecting a new mailbox is still the wizard's job, so the empty
 * state points there.
 */
const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.externalAccount.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

// `mail.external` defaults to OFF, so until the flags subscription lands
// `isEnabled` says false for an instance that actually has the feature. Waiting
// is the difference between a moment of "connected mailboxes are turned off" on
// every load and never saying it to the wrong person.
const { isEnabled, isLoading: flagsLoading } = useFeatureFlag();
const externalEnabled = computed(() => isEnabled('mail.external'));
</script>

<template>
	<div>
		<header class="mb-6">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.externalAccount.subheading') }}
			</p>
		</header>

		<!-- Carries the anchor so a settings deep link (`#connected-account`, from
		     the palette) has something to find on first paint, before the card
		     that normally owns it has mounted. -->
		<div
			v-if="flagsLoading"
			id="connected-account"
			class="card p-8 flex justify-center scroll-mt-6"
			aria-busy="true"
		>
			<Icon
				name="lucide:loader-2"
				class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
			/>
			<span class="sr-only">{{ t('common.loading') }}</span>
		</div>

		<PostboxConnectedAccountCard v-else-if="externalEnabled" />

		<!-- The feature is off on this instance: say so instead of showing an
		     empty card with a button that leads to a locked wizard. -->
		<section v-else class="card p-5">
			<h2 class="font-semibold">
				{{ t('dashboard.preferences.externalAccount.featureOffTitle') }}
			</h2>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('dashboard.preferences.externalAccount.featureOffBody') }}
			</p>
		</section>
	</div>
</template>
