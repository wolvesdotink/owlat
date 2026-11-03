<script setup lang="ts">
/**
 * The composer footer's Send. For a reply (`actions` set) it is a split button:
 * Send does what the "after replying" setting says, and the chevron opens a
 * menu with both ways ("Send and keep in Inbox", "Send and mark done"), each
 * with the chord that does it. Without `actions` (a new message, a forward, a
 * Team inbox reply) it is the plain button it always was.
 *
 * Emits `send` with no action for the button (the host applies the setting)
 * and with the chosen action for a menu entry.
 */
import type { ComposerSendActions, PostboxAfterReply } from '~/utils/postboxAfterReply';
import { POSTBOX_AFTER_REPLY_OPTIONS, POSTBOX_SEND_AND_LABELS } from '~/utils/postboxAfterReply';
import { ArchiveIcon, ChevronDownIcon, PaperPlaneIcon, type IconComponent } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const props = defineProps<{
	disabled: boolean;
	sending: boolean;
	title?: string;
	label?: string;
	icon?: IconComponent;
	actions?: ComposerSendActions;
}>();

const emit = defineEmits<{ (e: 'send', action?: PostboxAfterReply): void }>();

const { t } = useI18n();
const menuOpen = ref(false);

const ACTION_ICON: Record<PostboxAfterReply, IconComponent> = {
	keep: PaperPlaneIcon,
	done: ArchiveIcon,
};
const actionList = POSTBOX_AFTER_REPLY_OPTIONS.map((option) => option.value);
</script>

<template>
	<div class="flex shrink-0 items-center" data-testid="composer-send-group">
		<UiTooltip :text="title">
			<UiButton
				type="button"
				class="shrink-0 whitespace-nowrap"
				:class="{ 'rounded-r-none relative focus-visible:z-10': actions }"
				:disabled="disabled"
				data-testid="composer-send"
				@click="emit('send')"
			>
				<SpinnerIcon v-if="sending" class="w-4 h-4 mr-1.5" />
				<component v-else :is="icon ?? PaperPlaneIcon" class="w-4 h-4 mr-1.5" />
				{{
					label ??
					(sending ? t('components.postbox.postboxComposerFooter.sending') : t('common.send'))
				}}
			</UiButton>
		</UiTooltip>
		<UiDropdownMenu v-if="actions" v-model:open="menuOpen" position="left" class="flex">
			<template #trigger>
				<UiTooltip :text="t('components.postbox.postboxComposerFooter.sendOptions')">
					<UiButton
						type="button"
						class="rounded-l-none w-8 px-0 border-l border-text-inverse/20 relative focus-visible:z-10"
						:disabled="disabled"
						:aria-label="t('components.postbox.postboxComposerFooter.sendOptions')"
						data-testid="composer-send-options"
					>
						<ChevronDownIcon
							class="w-4 h-4 transition-transform duration-(--motion-fast)"
							:class="{ 'rotate-180': menuOpen }"
						/>
					</UiButton>
				</UiTooltip>
			</template>
			<UiDropdownMenuItem
				v-for="action in actionList"
				:key="action"
				:icon="ACTION_ICON[action]"
				:aria-keyshortcuts="props.actions?.aria[action]"
				:data-testid="`composer-send-${action}`"
				@click="emit('send', action)"
			>
				<span class="flex min-w-0 flex-1 flex-col text-left">
					<span>{{ t(POSTBOX_SEND_AND_LABELS[action]) }}</span>
					<span class="text-2xs text-text-tertiary">{{ props.actions?.chords[action] }}</span>
				</span>
			</UiDropdownMenuItem>
		</UiDropdownMenu>
	</div>
</template>
