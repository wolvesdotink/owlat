<script setup lang="ts">
/**
 * My settings → Connected mailboxes: every mailbox you use, and everything
 * about how it sends.
 *
 * The mailbox list, "Is my mail arriving?", the sending choice and the mailbox
 * move used to sit on General between the reading settings and the keyboard
 * shortcuts. They are about mailboxes, so they are here.
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
		<header class="mb-6 flex items-start justify-between gap-4">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.externalAccount.subheading') }}
			</p>
			<UiButton class="shrink-0" @click="navigateTo('/dashboard/preferences/add-account')">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.index.addAccount') }}
			</UiButton>
		</header>

		<!-- The mailboxes themselves: colour, rename, delete (admins). -->
		<PreferencesMailboxList class="mb-6" />

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

		<!-- Connecting outside accounts is off on this instance (the page is
		     reachable through Postbox): say only that, so it never reads as the
		     member's own mailboxes being switched off. -->
		<section v-else class="card p-5 mb-6">
			<h2 class="font-semibold">
				{{ t('dashboard.preferences.externalAccount.featureOffTitle') }}
			</h2>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('dashboard.preferences.externalAccount.featureOffBody') }}
			</p>
		</section>

		<!-- Is my mail arriving? The member-readable half of what the admin
		     delivery pages answer: my address's verification, my transport
		     alignment, and how my recent sends actually landed. -->
		<PostboxSendingHealthCard />

		<!-- Sending: reversible outbound-transport choice for a connected external
		     mailbox (own SMTP vs this instance). Self-hides for hosted-only users. -->
		<PostboxSendingSettings />

		<!-- Move my mailbox here: the staged full move of a connected external
		     mailbox onto a hosted one. Self-hides for hosted-only users. -->
		<PostboxMailboxMove />
	</div>
</template>
