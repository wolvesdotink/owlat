<script setup lang="ts">
useHead({ title: 'Email Translations — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const emailId = useRouteId<'emailTemplates'>();
</script>

<template>
	<TranslationManager :email-id="emailId" email-type="marketing" />
</template>
