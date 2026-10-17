<script setup lang="ts">
/**
 * Fix (read on arrival §4.2): "Where should mail like this go?" Opened from
 * the "Why here?" popover's "That's wrong". One destination, a scope (this
 * conversation, or everything from the sender) and an optional "why" that
 * becomes a draft rule for review in Rules. Saving is one undoable operation;
 * the toast says what it did and offers Undo.
 */
import { computed, ref, watch } from 'vue';
import {
	POSTBOX_FIX_DESTINATIONS,
	destinationForPlacement,
	usePostboxFixApply,
	type PostboxFixDestination,
	type PostboxFixScope,
	type PostboxFixTarget,
} from '~/composables/postbox/usePostboxArrivalExplain';

const props = defineProps<{ target: PostboxFixTarget | null }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const { apply, isApplying } = usePostboxFixApply();

/** Fix's reason field is capped server-side at the same length. */
const MAX_REASON_CHARS = 500;

const destination = ref<PostboxFixDestination>('updates');
const scope = ref<PostboxFixScope>('message');
const reason = ref('');

// Every open starts from where the mail sits now, for this conversation only.
watch(
	() => props.target,
	(next) => {
		if (!next) return;
		destination.value = next.placement ? destinationForPlacement(next.placement) : 'updates';
		scope.value = 'message';
		reason.value = '';
	},
	{ immediate: true }
);

const scopeOptions = computed(() => [
	{ value: 'message', label: t('postbox.fix.scope.message') },
	{
		value: 'sender',
		label: t('postbox.fix.scope.sender', { name: props.target?.senderName ?? '' }),
	},
]);

function onOpen(value: boolean) {
	if (!value) emit('close');
}

async function save() {
	const target = props.target;
	if (!target) return;
	const isApplied = await apply({
		messageId: target.messageId,
		destination: destination.value,
		scope: scope.value,
		reason: reason.value,
		senderName: target.senderName,
	});
	if (isApplied) emit('close');
}
</script>

<template>
	<UiModal :open="target !== null" :title="t('postbox.fix.title')" size="sm" @update:open="onOpen">
		<fieldset data-testid="fix-destinations">
			<legend class="sr-only">{{ t('postbox.fix.title') }}</legend>
			<label
				v-for="option in POSTBOX_FIX_DESTINATIONS"
				:key="option"
				class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-surface"
			>
				<input
					v-model="destination"
					type="radio"
					name="postbox-fix-destination"
					:value="option"
					class="accent-brand"
					:data-testid="`fix-destination-${option}`"
				/>
				<span>{{ t(`postbox.fix.destination.${option}`) }}</span>
			</label>
		</fieldset>
		<p class="mt-4 text-xs text-text-tertiary">{{ t('postbox.fix.applyTo') }}</p>
		<UiSegmentedControl
			v-model="scope"
			:options="scopeOptions"
			size="sm"
			class="mt-1"
			data-testid="fix-scope"
		/>
		<UiTextarea
			v-model="reason"
			class="mt-4"
			size="sm"
			:rows="2"
			:max-length="MAX_REASON_CHARS"
			:label="t('postbox.fix.reason.label')"
			:placeholder="t('postbox.fix.reason.placeholder')"
			data-testid="fix-reason"
		/>
		<p class="mt-1 text-xs text-text-tertiary">{{ t('postbox.fix.reason.help') }}</p>
		<template #footer>
			<UiButton variant="secondary" :disabled="isApplying" @click="emit('close')">
				{{ t('postbox.fix.cancel') }}
			</UiButton>
			<UiButton :loading="isApplying" data-testid="fix-save" @click="save">
				{{ t('postbox.fix.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
