<script setup lang="ts">
/**
 * Answer mode's envelope, folded to one line: "To Jonas · From Ada · Re: …".
 * The whole line opens the full envelope (From/To/Cc/Bcc/Subject); so does
 * anything in it needing attention, which the composer decides. When a plain
 * reply leaves people off, "Reply all" sits on the line itself, so the switch
 * is never hidden behind the fold.
 */
import { recipientLabel } from '~/utils/recipientHints';

const props = defineProps<{
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	/** The From identity as shown (label or address). */
	from: string;
	subject: string;
	/** A plain reply that Reply-all would widen. */
	canReplyAll: boolean;
}>();

const emit = defineEmits<{ expand: []; 'reply-all': [] }>();

const { t } = useI18n();

const names = (list: string[]) => list.map(recipientLabel).join(', ');
const toLine = computed(() => names(props.toAddresses));
const copyCount = computed(() => props.ccAddresses.length + props.bccAddresses.length);
</script>

<template>
	<div
		class="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-sm"
		data-testid="composer-envelope-line"
	>
		<button
			type="button"
			class="min-w-0 flex-1 truncate text-left hover:text-text-primary"
			:aria-label="t('components.postbox.postboxComposerEnvelopeLine.label')"
			@click="emit('expand')"
		>
			<span class="font-medium text-text-primary">{{
				t('components.postbox.postboxComposerEnvelopeLine.to', { names: toLine || '…' })
			}}</span>
			<span v-if="copyCount > 0" class="ml-1 text-text-tertiary">{{
				t('components.postbox.postboxComposerEnvelopeLine.copies', { count: copyCount })
			}}</span>
			<template v-if="from">
				<span class="mx-1.5 text-text-tertiary" aria-hidden="true">·</span>
				<span class="text-text-secondary">{{
					t('components.postbox.postboxComposerEnvelopeLine.from', { address: from })
				}}</span>
			</template>
			<template v-if="subject">
				<span class="mx-1.5 text-text-tertiary" aria-hidden="true">·</span>
				<span class="text-text-secondary">{{ subject }}</span>
			</template>
		</button>
		<button
			v-if="canReplyAll"
			type="button"
			class="shrink-0 text-xs text-brand hover:underline"
			data-testid="composer-envelope-reply-all"
			@click="emit('reply-all')"
		>
			{{ t('components.postbox.postboxComposerEnvelopeLine.replyAll') }}
		</button>
		<button
			type="button"
			class="shrink-0 text-xs text-text-tertiary hover:text-text-primary"
			@click="emit('expand')"
		>
			{{ t('components.postbox.postboxComposerEnvelopeLine.edit') }}
		</button>
	</div>
</template>
