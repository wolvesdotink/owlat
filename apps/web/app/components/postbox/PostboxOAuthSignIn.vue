<script setup lang="ts">
/**
 * The provider sign-in half of the mailbox connect form (Google or Microsoft) —
 * an OFFER beside the app password, never in place of it.
 *
 * Provider sign-in only exists on instances where an operator registered an
 * OAuth app with that provider, so the app-password form stays the path every
 * user can take and this block renders as the secondary alternative underneath
 * it. The one exception is re-authorizing a mailbox that is already connected
 * with the provider: there the reconnect IS the expected action, so it leads.
 *
 * Presentational on purpose — the parent form owns the connect intent (which of
 * the five connect/update flavours this mount is) and the operation that runs
 * it, since those are derived from props only it has.
 */
import { LogInIcon } from '@coolicons/vue';

const props = defineProps<{
	/** Whose sign-in this block offers; picks the copy. */
	provider: 'google' | 'microsoft';
	/** Connecting a new mailbox, or re-authorizing an existing one. */
	mode: 'connect' | 'update';
	/** The account being updated already authenticates with OAuth. */
	oauthAccount?: boolean;
	/**
	 * The block appeared because the typed address turned out to be hosted by the
	 * provider, not because the user picked the provider's card; the copy says so.
	 */
	detected?: boolean;
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
const FORM_KEY = 'components.postbox.postboxMailboxConnectForm';
const KEY = computed(() => `${FORM_KEY}.${props.provider}`);

// "Reconnect" only when there is an OAuth authorization to replace; an update
// on a password account is still a first provider connection.
const isReconnect = computed(() => props.mode === 'update' && props.oauthAccount === true);
const buttonLabel = computed(() =>
	isReconnect.value ? t(`${KEY.value}.reconnect`) : t(`${KEY.value}.continue`)
);
const explanation = computed(() => {
	if (isReconnect.value) return t(`${KEY.value}.reconnectExplain`);
	return props.detected ? t(`${FORM_KEY}.microsoft.detected`) : t(`${KEY.value}.explain`);
});
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
			<LogInIcon class="w-4 h-4" />
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
