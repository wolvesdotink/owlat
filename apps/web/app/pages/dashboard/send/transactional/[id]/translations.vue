<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('dashboard.send.transactional.detail.translations.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const emailId = useRouteId<'transactionalEmails'>();
</script>

<template>
	<TranslationManager :email-id="emailId" email-type="transactional" />
</template>
