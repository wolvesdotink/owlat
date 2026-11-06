<script setup lang="ts">
import type { MailAskAnswer, MailAskCitation } from '~/composables/useCommandPaletteMailAsk';
import { MailIcon } from '@coolicons/vue';
import { formatShortDate } from '~/utils/formatters';

/**
 * The palette's Ask your mailbox answer: the text with its `[n]` markers, a
 * note when only headers and snippets were read, and the cited messages, each
 * a button that opens the message. Presentational: opening leaves as an event.
 */

defineProps<{ answer: MailAskAnswer }>();

defineEmits<{ open: [citation: MailAskCitation] }>();

const { t } = useI18n();
</script>

<template>
	<div class="space-y-3">
		<p v-if="!answer.answer" class="text-sm text-text-secondary">
			{{ t('components.appCommandPalette.mailAsk.noMatches') }}
		</p>
		<div v-else class="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
			{{ answer.answer }}
		</div>
		<p v-if="answer.isTruncated" class="text-xs text-text-tertiary">
			{{ t('components.query.queryResult.cutOff') }}
		</p>
		<p
			v-if="!answer.bodySearchUsed"
			class="text-xs text-text-tertiary"
			data-testid="mail-ask-headers-only"
		>
			{{ t('components.appCommandPalette.mailAsk.headersOnly') }}
		</p>

		<div v-if="answer.citations.length > 0" class="pt-3 border-t border-border-subtle">
			<p class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-1">
				{{ t('components.query.queryResult.sources') }}
			</p>
			<button
				v-for="citation in answer.citations"
				:key="citation.messageId"
				type="button"
				class="w-full flex items-center gap-3 -mx-2 px-2 py-1.5 rounded-md text-left hover:bg-bg-surface transition-colors duration-(--motion-fast)"
				:aria-label="
					t('components.appCommandPalette.mailAsk.citationLabel', {
						index: citation.index,
						subject: citation.subject || t('components.appCommandPalette.noSubject'),
					})
				"
				@click="$emit('open', citation)"
			>
				<span class="flex-shrink-0 w-6 text-xs text-text-tertiary tabular-nums"
					>[{{ citation.index }}]</span
				>
				<MailIcon class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
				<span class="flex-1 min-w-0">
					<span class="block text-sm text-text-primary truncate">{{
						citation.subject || t('components.appCommandPalette.noSubject')
					}}</span>
					<span class="block text-xs text-text-tertiary truncate"
						>{{ citation.from }} · {{ formatShortDate(citation.date) }}</span
					>
				</span>
			</button>
		</div>
	</div>
</template>
