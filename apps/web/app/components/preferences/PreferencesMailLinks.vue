<script setup lang="ts">
const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
</script>

<template>
	<nav
		class="grid grid-cols-2 gap-3 mb-6"
		:aria-label="t('components.preferences.preferencesMailLinks.ariaLabel')"
	>
		<NuxtLink
			v-if="isEnabled('mail.external')"
			to="/dashboard/postbox/migrate"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3 border-brand/30"
		>
			<Icon name="lucide:mail" class="w-5 h-5 text-brand" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.import.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.import.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/filters"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:filter" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.filters.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.filters.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/aliases"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:at-sign" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.aliases.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.aliases.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/forwarding"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:forward" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.forwarding.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.forwarding.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/vacation"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:plane" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.vacation.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.vacation.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/signatures"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:signature" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.signatures.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.signatures.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/snippets"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:text-quote" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.snippets.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.snippets.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			v-if="isEnabled('ai')"
			to="/dashboard/preferences/writing-voice"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:wand-sparkles" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.writingVoice.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.writingVoice.description') }}
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/app-passwords"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:key-round" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">
					{{ t('components.preferences.preferencesMailLinks.appPasswords.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.preferences.preferencesMailLinks.appPasswords.description') }}
				</p>
			</div>
		</NuxtLink>
	</nav>
</template>
