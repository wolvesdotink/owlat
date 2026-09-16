<script setup lang="ts">
/**
 * The Google half of the mailbox connect form — an OFFER beside the app
 * password, never in place of it.
 *
 * Google sign-in only exists on instances where an operator went and created a
 * Google OAuth client, so the app-password form stays the path every Gmail user
 * can take and this block renders as the secondary alternative underneath it.
 * The one exception is re-authorizing a mailbox that is already connected with
 * Google: there the reconnect IS the expected action, so it leads.
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
	/**
	 * Where this block sits relative to the password form. It decides which side
	 * the "or" divider goes on, so the rule reads the same either way round: the
	 * divider always separates the two paths.
	 */
	placement: 'above' | 'below';
	/** The authorization request is in flight. */
	loading?: boolean;
	/** The consent screen went to the system browser (desktop app). */
	handedOffToBrowser?: boolean;
}>();

const emit = defineEmits<{
	(e: 'connect'): void;
}>();

const { t } = useI18n();
const KEY = 'components.postbox.postboxMailboxConnectForm.google';

// "Reconnect" only when there is an OAuth authorization to replace; an update
// on a password account is still a first Google connection.
const isReconnect = computed(() => props.mode === 'update' && props.oauthAccount === true);
const buttonLabel = computed(() =>
	isReconnect.value ? t(`${KEY}.reconnect`) : t(`${KEY}.continue`)
);
const explanation = computed(() =>
	isReconnect.value ? t(`${KEY}.reconnectExplain`) : t(`${KEY}.explain`)
);
</script>

<template>
	<div class="space-y-3">
		<div v-if="placement === 'below'" class="flex items-center gap-3" aria-hidden="true">
			<div class="flex-1 h-px bg-border-subtle" />
			<span class="text-xs uppercase tracking-wide text-text-secondary">{{ t(`${KEY}.or`) }}</span>
			<div class="flex-1 h-px bg-border-subtle" />
		</div>

		<UiButton
			type="button"
			:variant="isReconnect ? 'primary' : 'secondary'"
			:loading="loading"
			@click="emit('connect')"
		>
			<Icon name="lucide:log-in" class="w-4 h-4" />
			{{ buttonLabel }}
		</UiButton>

		<p class="text-sm text-text-secondary">{{ explanation }}</p>

		<p v-if="handedOffToBrowser" class="text-sm text-text-secondary">
			{{ t(`${KEY}.desktopHint`) }}
		</p>

		<div v-if="placement === 'above'" class="flex items-center gap-3" aria-hidden="true">
			<div class="flex-1 h-px bg-border-subtle" />
			<span class="text-xs uppercase tracking-wide text-text-secondary">{{ t(`${KEY}.or`) }}</span>
			<div class="flex-1 h-px bg-border-subtle" />
		</div>
	</div>
</template>
