<script setup lang="ts">
/**
 * The Team inbox reply's envelope, folded to one line like the Postbox
 * composer's ("To Ana · Re: Invoice"). The recipient is fixed, so only the
 * subject opens on a click. The subject's text stays with {@link ThreadComposer},
 * which tracks whether the person has touched it; this only renders it.
 */
import { ChevronDownIcon, SparklesIcon } from '@coolicons/vue';

defineProps<{
	/** Who a reply goes to ("To Ana Ruiz"). */
	senderLabel: string;
	subject: string;
	/** The editor holds an agent draft: the envelope tags it. */
	hasDraft: boolean;
	/** The person changed that draft. */
	edited: boolean;
}>();

const emit = defineEmits<{
	(e: 'subject-input', event: Event): void;
	/** Keys typed in the subject (⌘Enter sends from there too). */
	(e: 'keydown', event: KeyboardEvent): void;
}>();

/** The subject field is open under the folded line. */
const subjectOpen = defineModel<boolean>('subjectOpen', { default: false });

const { t } = useI18n();
</script>

<template>
	<div class="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-sm">
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-text-primary"
			:aria-expanded="subjectOpen"
			data-testid="thread-composer-envelope"
			@click="subjectOpen = !subjectOpen"
		>
			<span class="min-w-0 truncate">
				<span class="font-medium text-text-primary">{{
					t('components.answer.team.to', { name: senderLabel })
				}}</span>
				<template v-if="subject">
					<span class="mx-1.5 text-text-tertiary" aria-hidden="true">·</span>
					<span class="text-text-secondary">{{ subject }}</span>
				</template>
			</span>
			<ChevronDownIcon
				class="size-3 shrink-0 text-text-tertiary"
				:class="{ 'rotate-180': subjectOpen }"
				aria-hidden="true"
			/>
		</button>
		<span
			v-if="hasDraft"
			class="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-2xs font-medium text-brand"
			data-testid="thread-composer-draft-hint"
		>
			<SparklesIcon class="size-3" aria-hidden="true" />
			{{
				edited
					? t('dashboard.inbox.detail.composer.editedDraft')
					: t('dashboard.inbox.detail.composer.agentDraft')
			}}
		</span>
	</div>

	<div v-if="subjectOpen" class="border-b border-border-subtle px-4 py-2">
		<input
			:value="subject"
			type="text"
			class="input"
			:aria-label="t('dashboard.inbox.detail.composer.subjectLabel')"
			:placeholder="t('dashboard.inbox.detail.composer.subjectLabel')"
			data-testid="thread-composer-subject"
			@input="emit('subject-input', $event)"
			@keydown="emit('keydown', $event)"
		/>
	</div>
</template>
