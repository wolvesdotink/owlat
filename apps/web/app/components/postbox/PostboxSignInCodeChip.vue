<script setup lang="ts">
/**
 * The one-click chip for a sign-in code or link read at arrival
 * (`mail/signInCodes.ts`): copy the code, or open the link in the browser.
 *
 * The chip names the sender's domain so a look-alike domain stands out next to
 * the code it offers. It hides itself at `expiresAt` on the list's minute
 * clock, so it never waits for the server's clear to stop offering a stale
 * code.
 *
 * Both kinds are buttons, never an `<a>`: the row that renders the chip is
 * itself a link, and a click here must not open the message as well. The link
 * opens through `window.open`, which the desktop shell hands to the system
 * browser like any `target="_blank"` link in a message body.
 */
import type { Doc } from '@owlat/api/dataModel';
import { usePostboxRowNow } from '~/composables/postbox/usePostboxListClock';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import { CopyIcon, KeyIcon, LogInIcon } from '@coolicons/vue';

const props = defineProps<{
	signInCode: NonNullable<Doc<'mailMessages'>['signInCode']>;
	/** The reader's card, under the header, shows the full link label; a row keeps it short. */
	size?: 'row' | 'reader';
}>();

const { t } = useI18n();
const { showToast } = useToast();
const { copy } = useCopyToClipboard();
const now = usePostboxRowNow();

const isLive = computed(() => now.value < props.signInCode.expiresAt);

const label = computed(() =>
	props.signInCode.kind === 'code'
		? t('components.postbox.postboxSignInCodeChip.copyLabel', {
				code: props.signInCode.value,
				domain: props.signInCode.senderDomain,
			})
		: t('components.postbox.postboxSignInCodeChip.openLabel', {
				domain: props.signInCode.senderDomain,
			})
);

async function onClick(event: MouseEvent) {
	event.stopPropagation();
	event.preventDefault();
	if (props.signInCode.kind === 'link') {
		window.open(props.signInCode.value, '_blank', 'noopener,noreferrer');
		return;
	}
	const copied = await copy(props.signInCode.value);
	if (copied) showToast(t('components.postbox.postboxSignInCodeChip.copied'));
	else showToast(t('components.postbox.postboxSignInCodeChip.copyFailed'), 'error');
}
</script>

<template>
	<UiTooltip v-if="isLive" :text="label">
		<button
			type="button"
			class="pbx-sign-in-chip inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-brand/40 text-brand hover:bg-brand/10 whitespace-nowrap flex-shrink-0"
			:class="size === 'reader' ? 'mt-3 text-xs' : 'text-[11px]'"
			:aria-label="label"
			data-testid="sign-in-code-chip"
			@click="onClick"
		>
			<template v-if="signInCode.kind === 'code'">
				<KeyIcon class="w-3 h-3" />
				<span class="font-mono font-semibold tracking-wider">{{ signInCode.value }}</span>
				<CopyIcon class="w-3 h-3" />
			</template>
			<template v-else>
				<LogInIcon class="w-3 h-3" />
				<span class="font-medium">{{
					t(
						size === 'reader'
							? 'components.postbox.postboxSignInCodeChip.openLink'
							: 'components.postbox.postboxSignInCodeChip.openLinkShort'
					)
				}}</span>
			</template>
			<span class="text-text-tertiary">{{ signInCode.senderDomain }}</span>
		</button>
	</UiTooltip>
</template>
