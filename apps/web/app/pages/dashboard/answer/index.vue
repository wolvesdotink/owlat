<script setup lang="ts">
/**
 * The Answer queue page: everything waiting on the viewer's answer. Replaces
 * the separate personal Reply Queue and the team Review Queue (both routes
 * redirect here). `?in=team` narrows it to the team inbox, `?in=<mailboxId>` to
 * one mailbox, `?in=chat` to chat mentions.
 *
 * Opening it opens Answer mode on the first item (plan §07); what stays here is
 * the loading, empty and done states and the items that have no Answer mode
 * (chat mentions, follow-up reminders), shown as cards.
 */
const { t } = useI18n();
useHead({ title: () => t('dashboard.answer.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<h1 class="sr-only">{{ t('dashboard.answer.pageTitle') }}</h1>
		<AnswerQueueFlow />
	</div>
</template>
