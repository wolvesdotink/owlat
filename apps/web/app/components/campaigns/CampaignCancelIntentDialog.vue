<script setup lang="ts">
/**
 * The confirmation a "Cancel send" notification button opens.
 *
 * The scheduled-campaign reminder (Web Push) carries Open and Cancel; Cancel
 * opens the campaign as `?intent=cancel`, and this dialog asks before anything
 * happens: a cancelled campaign cannot be scheduled again, and a notification
 * button is easy to press by accident. The intent is read once, when the
 * campaign has loaded, and then dropped from the address so a reload does not
 * ask again. A campaign that is no longer scheduled (it started, or someone
 * cancelled or unscheduled it) says so instead of asking.
 */

const props = defineProps<{
	/** The campaign has loaded; the intent waits for it. */
	isLoaded: boolean;
	isScheduled: boolean;
	name: string;
	scheduledAtDisplay: string;
	isLoading: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

const { t } = useI18n();
const { showToast } = useToast();
const route = useRoute();
const router = useRouter();

const isOpen = ref(false);

watch(
	() => [props.isLoaded, route.query['intent']] as const,
	([isLoaded, intent]) => {
		if (!isLoaded || intent !== 'cancel') return;
		const { intent: _handled, ...rest } = route.query;
		void router.replace({ query: rest });
		if (props.isScheduled) isOpen.value = true;
		else showToast(t('components.campaigns.cancelIntentDialog.notScheduled'), 'info');
	},
	{ immediate: true }
);

function onConfirm(): void {
	isOpen.value = false;
	emit('confirm');
}
</script>

<template>
	<UiConfirmationDialog
		:open="isOpen && isScheduled"
		variant="danger"
		:title="t('components.campaigns.cancelIntentDialog.title')"
		:description="
			t('components.campaigns.cancelIntentDialog.description', {
				name,
				date: scheduledAtDisplay,
			})
		"
		:confirm-text="t('components.campaigns.cancelIntentDialog.confirm')"
		:cancel-text="t('components.campaigns.cancelIntentDialog.keep')"
		:is-loading="isLoading"
		@update:open="isOpen = $event"
		@confirm="onConfirm"
	/>
</template>
