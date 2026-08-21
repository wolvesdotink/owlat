<script setup lang="ts">
/**
 * Language sits beside Appearance because it is the same kind of setting: a
 * per-person, per-device display choice that no admin owns and nothing on the
 * server needs to know about. It is stored the same way too — a cookie in this
 * browser, not a field on the account — so switching it on a phone leaves the
 * desktop session alone.
 */
const { t } = useI18n();
</script>

<template>
	<section class="card mb-6">
		<div class="mb-4">
			<h2 class="font-semibold text-text-primary">
				{{ t('components.preferences.preferencesLanguage.title') }}
			</h2>
			<p class="text-sm text-text-secondary">
				{{ t('components.preferences.preferencesLanguage.subtitle') }}
			</p>
		</div>
		<LanguagePicker />
		<p class="mt-3 text-xs text-text-tertiary">
			{{ t('components.preferences.preferencesLanguage.hint') }}
		</p>
	</section>
</template>
