<script setup lang="ts">
/**
 * How a Microsoft sign-in mailbox sends, and the way to let it send through
 * Microsoft Graph.
 *
 * Many Microsoft 365 tenants turn SMTP AUTH off. The mail-sync worker then sends
 * through Graph instead, which needs the `Mail.Send` permission. A mailbox
 * connected before Owlat asked for it, or one whose organization withheld it,
 * has no way to send once SMTP is refused, so the row offers the one fix:
 * signing in with Microsoft again. The personal card and the team inbox card
 * both render this; a team inbox passes its `mailboxId`.
 *
 * Renders nothing for any other account.
 */
import type { Id } from '@owlat/api/dataModel';
import { useMailOAuthConnect } from '~/composables/postbox/useMailOAuthConnect';

const props = defineProps<{
	account: {
		authMethod?: string;
		oauthProvider?: string;
		sendPath?: 'smtp' | 'graph';
		graphConsent?: 'granted' | 'missing';
	};
	/** The team inbox this row belongs to; omitted for the caller's own mailbox. */
	mailboxId?: Id<'mailboxes'>;
}>();

const { t } = useI18n();
const route = useRoute();
const KEY = 'components.postbox.postboxMicrosoftSendPath';

const isMicrosoft = computed(
	() => props.account.authMethod === 'oauth2' && props.account.oauthProvider === 'microsoft'
);
const viaGraph = computed(() => props.account.sendPath === 'graph');
const needsConsent = computed(() => props.account.graphConsent === 'missing');

const consentError = ref<string | null>(null);
const oauth = useMailOAuthConnect({ inlineTarget: consentError });

async function grantSendPermission() {
	consentError.value = null;
	await oauth.connect(
		'microsoft',
		props.mailboxId ? { kind: 'updateShared', mailboxId: props.mailboxId } : { kind: 'update' },
		route.fullPath
	);
}
</script>

<template>
	<div v-if="isMicrosoft" data-testid="microsoft-send-path">
		<div class="flex flex-wrap items-center gap-2">
			<span class="font-medium text-sm">{{ t(`${KEY}.label`) }}</span>
			<span
				class="text-xs px-2 py-0.5 rounded bg-bg-surface text-text-secondary"
				data-testid="microsoft-send-path-badge"
			>
				{{ viaGraph ? t(`${KEY}.graph`) : t(`${KEY}.smtp`) }}
			</span>
		</div>
		<p class="text-xs text-text-tertiary mt-0.5">
			{{ viaGraph ? t(`${KEY}.graphHelp`) : t(`${KEY}.smtpHelp`) }}
		</p>

		<div
			v-if="needsConsent"
			class="mt-3 rounded-lg border border-border-subtle p-3 flex flex-wrap items-center justify-between gap-3"
			data-testid="microsoft-send-consent"
		>
			<p class="text-xs text-text-secondary min-w-0 flex-1">
				{{ viaGraph ? t(`${KEY}.consentNeededGraph`) : t(`${KEY}.consentNeeded`) }}
			</p>
			<UiButton
				variant="secondary"
				size="sm"
				:disabled="oauth.isLoading.value"
				data-testid="microsoft-send-consent-button"
				@click="grantSendPermission"
			>
				{{ t(`${KEY}.grant`) }}
			</UiButton>
			<p v-if="oauth.handedOffToBrowser.value" class="text-xs text-text-tertiary basis-full">
				{{ t(`${KEY}.continueInBrowser`) }}
			</p>
			<p v-if="consentError" class="text-xs text-error basis-full" role="alert">
				{{ consentError }}
			</p>
		</div>
	</div>
</template>
