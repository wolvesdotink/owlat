<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('dashboard.send.emails.detail.translations.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const emailId = useRouteId<'emailTemplates'>();
</script>

<template>
	<TranslationManager :email-id="emailId" email-type="marketing" />
</template>
