<script setup lang="ts">
import type { AppPasswordHelp } from '~/utils/mailAutodiscover';

// Actionable app-password guidance for the big consumer providers that reject a
// plain account password over IMAP/SMTP once 2FA is on. `authError` sharpens the
// wording: when the mailbox is actively failing on credentials we lead with the
// fix ("...not your account password"); otherwise it's a proactive heads-up.
const props = defineProps<{
	help: AppPasswordHelp;
	authError?: boolean;
}>();

const heading = computed(() =>
	props.authError
		? `${props.help.provider} needs an app password, not your account password`
		: `${props.help.provider} needs an app password`,
);
</script>

<template>
	<div class="rounded-lg border border-border-subtle bg-bg-surface p-4 text-sm space-y-1">
		<p class="font-medium flex items-center gap-1.5">
			<Icon name="lucide:key-round" class="w-3.5 h-3.5 text-info" />
			{{ heading }}
		</p>
		<p class="text-text-secondary">{{ help.steps }}</p>
		<a
			:href="help.url"
			target="_blank"
			rel="noopener noreferrer"
			class="text-info underline inline-flex items-center gap-1"
		>
			Open {{ help.provider }} app-password page
			<Icon name="lucide:external-link" class="w-3 h-3" />
		</a>
	</div>
</template>
