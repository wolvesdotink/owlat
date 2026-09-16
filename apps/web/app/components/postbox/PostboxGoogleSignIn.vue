<script setup lang="ts">
/**
 * The Google half of the mailbox connect form.
 *
 * Google is phasing out password auth for IMAP/SMTP, so when the instance has
 * an OAuth client configured we lead with "Continue with Google" instead of
 * asking for an app password. It stays an OFFER, not a wall: the secondary
 * button hands the full app-password form back, because a Workspace tenant can
 * block third-party OAuth apps outright and app passwords still work there.
 *
 * Presentational on purpose — the parent form owns the connect intent (which of
 * the five connect/update flavours this mount is) and the operation that runs
 * it, since those are derived from props only it has.
 */
const props = defineProps<{
	/** Connecting a new mailbox, or re-authorizing an existing one. */
	mode: 'connect' | 'update';
	/** The account being updated already authenticates with OAuth. */
	oauthAccount?: boolean;
	/** The authorization request is in flight. */
	loading?: boolean;
	/** The consent screen went to the system browser (desktop app). */
	handedOffToBrowser?: boolean;
}>();

const emit = defineEmits<{
	(e: 'connect'): void;
	(e: 'useAppPassword'): void;
}>();

const { t } = useI18n();
const KEY = 'components.postbox.postboxMailboxConnectForm.google';

// "Reconnect" only when there is an OAuth authorization to replace; an update
// on a password account is still a first Google connection.
const buttonLabel = computed(() =>
	props.mode === 'update' && props.oauthAccount ? t(`${KEY}.reconnect`) : t(`${KEY}.continue`)
);
</script>

<template>
	<div class="space-y-3">
		<p class="text-sm text-text-secondary">{{ t(`${KEY}.explain`) }}</p>

		<UiButton type="button" variant="primary" :loading="loading" @click="emit('connect')">
			<Icon name="lucide:log-in" class="w-4 h-4" />
			{{ buttonLabel }}
		</UiButton>

		<p v-if="handedOffToBrowser" class="text-sm text-text-secondary">
			{{ t(`${KEY}.desktopHint`) }}
		</p>

		<div>
			<UiButton type="button" variant="ghost" size="sm" @click="emit('useAppPassword')">
				{{ t(`${KEY}.useAppPassword`) }}
			</UiButton>
		</div>
	</div>
</template>
