<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { parseSnapshotBlocks } from '@owlat/email-builder';
import type { CompareSide } from '~/components/email/TemplateCompareModal.vue';

/**
 * The Review step's "changed since the last send" line for one email template.
 *
 * The baseline is the template's newest send snapshot, whichever campaign it
 * was (`emailTemplates.versions.latestSend`): the body that send started with.
 * When the history holds no send (never sent, or evicted by the retention
 * cap) the line says so rather than comparing against an older event.
 * Comparing opens both versions side by side; it never writes.
 */
const props = defineProps<{ templateId: Id<'emailTemplates'> }>();

const { t, locale } = useI18n();
const { showToast } = useToast();
const convex = useConvex();

const KEY = 'components.campaigns.changedSinceLastSend';

const { data: latest } = useOrganizationQuery(api.emailTemplates.versions.latestSend, () => ({
	templateId: props.templateId,
}));

const sentAt = computed(() =>
	latest.value ? new Date(latest.value.version.sentAt).toLocaleString(locale.value) : ''
);

const isOpen = ref(false);
const isLoading = ref(false);
const before = shallowRef<CompareSide | null>(null);
const after = shallowRef<CompareSide | null>(null);
// A comparison closed, or reopened for another template, drops a late answer.
let request = 0;

watch(isOpen, (open) => {
	if (!open) request++;
});

async function compare() {
	const found = latest.value;
	if (!found || !convex) return;
	const ticket = ++request;
	isOpen.value = true;
	isLoading.value = true;
	before.value = null;
	after.value = null;
	try {
		const [snapshot, template] = await Promise.all([
			convex.query(api.emailTemplates.versions.get, { versionId: found.version._id }),
			convex.query(api.emailTemplates.emails.get, { templateId: props.templateId }),
		]);
		if (ticket !== request) return;
		if (!template) throw new Error('Template not found');
		before.value = {
			label: t(`${KEY}.lastSendLabel`),
			detail: new Date(found.version.sentAt).toLocaleString(locale.value),
			blocks: parseSnapshotBlocks(snapshot.content),
			subject: snapshot.subject,
			previewText: snapshot.previewText ?? '',
		};
		after.value = {
			label: t(`${KEY}.nowLabel`),
			detail: template.name,
			blocks: parseSnapshotBlocks(template.content),
			subject: template.subject,
			previewText: template.previewText ?? '',
		};
	} catch {
		if (ticket !== request) return;
		isOpen.value = false;
		showToast(t(`${KEY}.loadFailed`), 'error');
	} finally {
		if (ticket === request) isLoading.value = false;
	}
}
</script>

<template>
	<div v-if="latest !== undefined" data-testid="changed-since-last-send">
		<p v-if="latest === null" class="flex items-center gap-2 text-sm text-text-tertiary">
			<Icon name="lucide:history" class="h-4 w-4 shrink-0" />
			{{ t(`${KEY}.noSend`) }}
		</p>
		<p
			v-else-if="latest.unchanged"
			class="flex items-center gap-2 text-sm text-text-secondary"
			:title="sentAt"
		>
			<Icon name="lucide:check-circle-2" class="h-4 w-4 shrink-0 text-success" />
			{{ t(`${KEY}.unchanged`, { time: formatRelativeTime(latest.version.sentAt) }) }}
		</p>
		<div v-else class="flex flex-wrap items-center gap-x-3 gap-y-2">
			<p class="flex items-center gap-2 text-sm text-text-secondary" :title="sentAt">
				<Icon name="lucide:git-compare" class="h-4 w-4 shrink-0 text-warning" />
				{{ t(`${KEY}.changed`, { time: formatRelativeTime(latest.version.sentAt) }) }}
			</p>
			<UiButton variant="outline" size="sm" data-testid="compare-last-send" @click="compare">
				{{ t(`${KEY}.compare`) }}
			</UiButton>
		</div>

		<EmailTemplateCompareModal
			v-model:open="isOpen"
			:before="before"
			:after="after"
			:loading="isLoading"
		/>
	</div>
</template>
