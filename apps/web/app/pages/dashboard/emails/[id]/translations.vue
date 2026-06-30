<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Email Translations — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const emailId = route.params['id'] as Id<'emailTemplates'>;
</script>

<template>
	<TranslationManager :email-id="emailId" email-type="marketing" />
</template>
