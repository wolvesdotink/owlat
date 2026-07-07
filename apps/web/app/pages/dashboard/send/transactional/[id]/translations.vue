<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Transactional Email Translations — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const emailId = route.params['id'] as Id<'transactionalEmails'>;
</script>

<template>
	<TranslationManager :email-id="emailId" email-type="transactional" />
</template>
