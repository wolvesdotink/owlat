<script setup lang="ts">
useHead({ title: 'Transactional Email Translations — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const emailId = useRouteId<'transactionalEmails'>();
</script>

<template>
	<TranslationManager :email-id="emailId" email-type="transactional" />
</template>
