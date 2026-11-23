<script setup lang="ts">
/**
 * Why sends did not arrive, for one failure class: the sentence first, the
 * page that fixes it (for an admin; a member is told to ask one), and the
 * recorded error text one click away. An unknown code has no sentence that
 * says more than "unknown", so its text is shown right away.
 *
 * Takes the class, or one send's status, bounce type and code to derive it
 * from: the send page loads this component lazily, so the catalog stays off
 * its first load when the send arrived.
 */
import {
	failureClassOfSend,
	failureFixLink,
	failureReasonKey,
	type SendFailureClass,
} from '~/lib/sendFailureReasons';

const props = defineProps<{
	failureClass?: SendFailureClass;
	status?: string;
	bounceType?: 'hard' | 'soft';
	errorCode?: string | null;
	providerText?: string | null;
}>();

const { t } = useI18n();
const { isAdmin } = usePermissions();

const failureClass = computed(
	() =>
		props.failureClass ??
		failureClassOfSend({
			status: props.status,
			bounceType: props.bounceType,
			errorCode: props.errorCode,
		})
);
const fix = computed(() => failureFixLink(failureClass.value));
const isUnknown = computed(() => failureClass.value === 'unknown');
const showProviderText = ref(false);
const hasDetails = computed(() => Boolean(props.providerText || props.errorCode));
const detailsId = useId();
</script>

<template>
	<div class="space-y-1 text-sm" data-testid="send-failure-reason">
		<p class="text-text-primary">{{ t(failureReasonKey(failureClass)) }}</p>
		<NuxtLink
			v-if="fix && isAdmin"
			:to="fix.to"
			class="link font-medium block w-fit"
			data-testid="send-failure-fix"
		>
			{{ t(fix.labelKey) }}
		</NuxtLink>
		<p v-else-if="fix" class="text-text-secondary">
			{{ t(fix.askKey ?? 'shared.campaignRefusal.askAdmin') }}
		</p>
		<template v-if="hasDetails">
			<button
				v-if="!isUnknown"
				type="button"
				class="block text-xs text-text-tertiary hover:text-text-primary underline-offset-2 hover:underline"
				:aria-expanded="showProviderText"
				:aria-controls="detailsId"
				@click="showProviderText = !showProviderText"
			>
				{{
					showProviderText
						? t('shared.sendFailure.hideProviderText')
						: t('shared.sendFailure.showProviderText')
				}}
			</button>
			<div
				v-if="isUnknown || showProviderText"
				:id="detailsId"
				class="rounded-md bg-bg-surface px-3 py-2 text-xs text-text-secondary break-words"
				data-testid="send-failure-provider-text"
			>
				<p v-if="providerText">{{ providerText }}</p>
				<p v-if="errorCode" class="font-mono text-text-tertiary">
					{{ t('shared.sendFailure.code', { code: errorCode }) }}
				</p>
			</div>
		</template>
	</div>
</template>
