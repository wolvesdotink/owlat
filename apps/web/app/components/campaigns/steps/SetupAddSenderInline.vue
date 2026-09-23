<script setup lang="ts">
/**
 * "Add a sender" inline in the campaign wizard (#785), for admins only.
 *
 * A workspace with no campaign senders used to dead-end the wizard with "ask
 * your admin" — even for the admin. This is the same add path as
 * Settings → Campaign senders (`useAddCampaignSender`), rendered in place so the campaign in progress is never left behind. It is a
 * plain `div`, not a `<form>`: it sits inside the wizard's own form, and
 * nested forms are invalid HTML.
 */
import type { Id } from '@owlat/api/dataModel';
import { useAddCampaignSender } from '~/composables/useAddCampaignSender';

const emit = defineEmits<{
	added: [senderId: Id<'campaignSenders'>];
}>();

const { t } = useI18n();

const prefix = 'components.campaigns.steps.setupAddSenderInline';

const { email, displayName, addError, creating, verification, verificationMessage, reset, add: create } =
	useAddCampaignSender({ operationLabel: () => t(`${prefix}.operation`) });

async function add() {
	const senderId = await create();
	if (senderId) {
		emit('added', senderId);
		reset();
	}
}
</script>

<template>
	<div class="space-y-3" data-testid="add-sender-inline" @keydown.enter.prevent="add">
		<UiErrorAlert v-if="addError" :message="addError" />
		<div class="grid gap-3 sm:grid-cols-2">
			<UiInput
				v-model="email"
				type="email"
				:label="t(`${prefix}.emailLabel`)"
				:placeholder="t(`${prefix}.emailPlaceholder`)"
				:disabled="creating"
			/>
			<UiInput
				v-model="displayName"
				:label="t(`${prefix}.nameLabel`)"
				:placeholder="t(`${prefix}.namePlaceholder`)"
				:disabled="creating"
			/>
		</div>
		<p
			:class="[
				'text-xs flex items-start gap-1.5',
				verification.tone === 'warning'
					? 'text-warning'
					: verification.tone === 'success'
						? 'text-success'
						: 'text-text-tertiary',
			]"
			data-testid="add-sender-verification"
		>
			<Icon
				v-if="verification.tone !== 'neutral'"
				:name="verification.tone === 'success' ? 'lucide:check-circle' : 'lucide:alert-triangle'"
				class="w-3.5 h-3.5 shrink-0 mt-px"
			/>
			<span>
				{{ verificationMessage }}
				<NuxtLink
					v-if="verification.showDomainsLink"
					to="/dashboard/admin/delivery/domains"
					class="underline whitespace-nowrap"
				>
					{{ t(`${prefix}.setUpDomain`) }}
				</NuxtLink>
			</span>
		</p>
		<div class="flex flex-wrap items-center gap-3">
			<UiButton
				size="sm"
				:loading="creating"
				:disabled="creating || !verification.canAdd"
				data-testid="add-sender-submit"
				@click="add"
			>
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t(`${prefix}.submit`) }}
			</UiButton>
			<NuxtLink
				to="/dashboard/admin/team/senders"
				class="text-sm text-text-secondary hover:text-text-primary"
			>
				{{ t(`${prefix}.manageAll`) }}
			</NuxtLink>
		</div>
	</div>
</template>
