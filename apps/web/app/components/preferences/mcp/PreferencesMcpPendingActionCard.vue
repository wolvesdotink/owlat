<script setup lang="ts">
import { api } from '@owlat/api';
import type { McpActionReview, McpPendingAction } from '~/composables/useMcpPendingActions';
import { formatCompactFileSize } from '~/utils/formatters';
import { mcpReviewPreviewSrcdoc } from '~/utils/mcpReviewPreview';

/**
 * `action` is the list's summary; the card loads the full review (every
 * recipient, the whole body as it goes out, the digest approval takes) when
 * it opens. `notice`: why the last approval was refused, shown until the next
 * try.
 */
const props = defineProps<{ action: McpPendingAction; busy: boolean; notice?: string | null }>();

const emit = defineEmits<{ (e: 'approve', reviewDigest: string): void; (e: 'reject'): void }>();

const { t } = useI18n();
const { formatRelativeTime } = useFormat();

const KEY = 'components.preferences.mcpPendingActionCard';

const TITLE_KEYS = {
	create_draft: `${KEY}.titles.createDraft`,
	send_draft: `${KEY}.titles.sendDraft`,
	archive_thread: `${KEY}.titles.archiveThread`,
	move_thread: `${KEY}.titles.moveThread`,
	label_thread: `${KEY}.titles.labelThread`,
} as const;

const {
	data: loaded,
	error: reviewError,
	refetch: refetchReview,
} = useConvexQuery(api.mcp.actions.getReview, () => ({
	actionId: props.action._id,
}));
/** The review of this card's action only, never one still held for another. */
const review = computed(() =>
	loaded.value === null || loaded.value?._id === props.action._id ? loaded.value : undefined
);

const summary = computed(() => props.action.summary);
/**
 * Null until the review loaded; what the card shows of the action from then on.
 * Typed by its declared union: an inferred `??` union drops the send's shape
 * into the all-optional ones, and `in` checks then stop narrowing.
 */
const details = computed<McpActionReview['details'] | null>(() => review.value?.details ?? null);
const title = computed(() => {
	const tool = props.action.tool;
	if (tool === 'label_thread' && 'isRemoval' in summary.value && summary.value.isRemoval) {
		return t(`${KEY}.titles.unlabelThread`, { client: props.action.clientLabel });
	}
	return t(TITLE_KEYS[tool], { client: props.action.clientLabel });
});

const isMessage = computed(
	() => props.action.tool === 'create_draft' || props.action.tool === 'send_draft'
);
const isDraftGone = computed(
	() => details.value !== null && 'isDraftGone' in details.value && details.value.isDraftGone
);
const isInaccessible = computed(
	() =>
		('isInaccessible' in summary.value && summary.value.isInaccessible) ||
		(details.value !== null && 'isInaccessible' in details.value && details.value.isInaccessible)
);
const isLoadingReview = computed(
	() => review.value === undefined && !isInaccessible.value && !reviewError.value
);
/**
 * Approval is bound to the digest of the review this card shows; until that
 * loaded, or without one, there is nothing the owner could have reviewed.
 */
const reviewDigest = computed(() => review.value?.reviewDigest ?? null);
const canApprove = computed(
	() => !isDraftGone.value && !isInaccessible.value && reviewDigest.value !== null
);
const from = computed(() => (details.value && 'from' in details.value ? details.value.from : null));
const attachments = computed(() =>
	details.value && 'attachments' in details.value ? details.value.attachments : []
);
// Sealing is only a choice where Sealed mail is on; elsewhere every send is ordinary mail.
const sealing = computed(() =>
	details.value &&
	'sealing' in details.value &&
	!(!details.value.sealing.isSealed && details.value.sealing.reason === 'flag_off')
		? details.value.sealing
		: null
);
const summaryLine = computed(() => {
	const value = summary.value;
	if ('isInaccessible' in value) return '';
	return value.subject || value.threadSubject || '';
});

/**
 * A send previews its HTML part as the recipient sees it, with all of its text
 * beside it and its links below. The preview cannot show what the outgoing
 * stylesheet reveals only in some clients or modes, so the text is never
 * behind a click. A drafted body is text only.
 */
const html = computed(() =>
	details.value && 'html' in details.value && details.value.html ? details.value.html : null
);
const previewSrcdoc = computed(() => (html.value ? mcpReviewPreviewSrcdoc(html.value) : ''));
const hasHiddenContent = computed(
	() =>
		details.value !== null && 'hasHiddenContent' in details.value && details.value.hasHiddenContent
);
const links = computed(() =>
	details.value && 'links' in details.value ? details.value.links : []
);
const LINK_PARTS = ['html', 'text', 'amp'] as const;
const linkGroups = computed(() =>
	LINK_PARTS.map((part) => ({
		part,
		links: links.value.filter((link) => link.part === part),
	})).filter((group) => group.links.length > 0)
);

function list(addresses: string[] | undefined) {
	return addresses && addresses.length > 0 ? addresses.join(', ') : '';
}

function approve() {
	if (reviewDigest.value !== null) emit('approve', reviewDigest.value);
}
</script>

<template>
	<article class="rounded-md border border-border-subtle bg-bg-elevated p-4 text-sm">
		<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<h3 class="font-medium">{{ title }}</h3>
			<span class="text-xs text-text-tertiary">
				{{ t(`${KEY}.asked`, { time: formatRelativeTime(action.createdAt) }) }}
			</span>
		</header>
		<p v-if="action.mailboxAddress" class="text-xs text-text-secondary mt-0.5 break-all">
			{{ action.mailboxAddress }}
		</p>

		<p v-if="isInaccessible" class="mt-3 text-text-secondary">
			{{ t(`${KEY}.inaccessible`) }}
		</p>
		<!-- A failed review read is not a review that is still loading: approval
		     stays off until it loads, so the owner needs a way to ask again. -->
		<div v-else-if="reviewError && review === undefined" class="mt-3" data-test="review-error">
			<p v-if="summaryLine" class="break-words">{{ summaryLine }}</p>
			<UiQueryBoundary :error="reviewError" @retry="refetchReview" />
		</div>
		<div v-else-if="isLoadingReview" class="mt-3 text-text-secondary" data-test="loading">
			<p v-if="summaryLine" class="break-words text-text-primary">{{ summaryLine }}</p>
			<p>{{ t(`${KEY}.loadingReview`) }}</p>
		</div>
		<p v-else-if="!details" class="mt-3 text-text-secondary">{{ t(`${KEY}.reviewGone`) }}</p>
		<p v-else-if="isDraftGone" class="mt-3 text-text-secondary">{{ t(`${KEY}.draftGone`) }}</p>
		<dl v-else class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
			<template v-if="isMessage">
				<template v-if="from">
					<dt class="text-text-tertiary">{{ t(`${KEY}.from`) }}</dt>
					<dd class="break-all">
						{{ from.address }}
						<span v-if="from.isSendAs && from.mailboxName" class="text-text-secondary">
							{{ t(`${KEY}.sendAs`, { name: from.mailboxName }) }}
						</span>
					</dd>
				</template>
				<dt class="text-text-tertiary">{{ t(`${KEY}.to`) }}</dt>
				<dd class="break-all">{{ 'to' in details ? list(details.to) : '' }}</dd>
				<template v-if="'cc' in details && list(details.cc)">
					<dt class="text-text-tertiary">{{ t(`${KEY}.cc`) }}</dt>
					<dd class="break-all">{{ list(details.cc) }}</dd>
				</template>
				<template v-if="'bcc' in details && list(details.bcc)">
					<dt class="text-text-tertiary">{{ t(`${KEY}.bcc`) }}</dt>
					<dd class="break-all">{{ list(details.bcc) }}</dd>
				</template>
				<dt class="text-text-tertiary">{{ t(`${KEY}.subject`) }}</dt>
				<dd class="break-words">
					{{ ('subject' in details && details.subject) || t(`${KEY}.noSubject`) }}
				</dd>
				<template v-if="'inReplyToSubject' in details && details.inReplyToSubject">
					<dt class="text-text-tertiary">{{ t(`${KEY}.inReplyTo`) }}</dt>
					<dd class="break-words">{{ details.inReplyToSubject }}</dd>
				</template>
				<template v-if="sealing">
					<dt class="text-text-tertiary">{{ t(`${KEY}.sealing`) }}</dt>
					<dd data-test="sealing">
						{{ sealing.isSealed ? t(`${KEY}.sealed`) : t(`${KEY}.notSealed`) }}
					</dd>
				</template>
				<template v-if="attachments.length > 0">
					<dt class="text-text-tertiary">{{ t(`${KEY}.attachments`) }}</dt>
					<dd>
						<ul data-test="attachments">
							<li v-for="(file, index) in attachments" :key="index" class="break-all">
								{{ file.filename }}
								<span class="text-text-tertiary">{{ formatCompactFileSize(file.size) }}</span>
							</li>
						</ul>
					</dd>
				</template>
			</template>
			<template v-else>
				<dt class="text-text-tertiary">{{ t(`${KEY}.conversation`) }}</dt>
				<dd class="break-words">
					{{ ('threadSubject' in details && details.threadSubject) || t(`${KEY}.noSubject`) }}
				</dd>
				<template v-if="'folderName' in details && details.folderName">
					<dt class="text-text-tertiary">{{ t(`${KEY}.folder`) }}</dt>
					<dd class="break-words">{{ details.folderName }}</dd>
				</template>
				<template v-if="'labelName' in details && details.labelName">
					<dt class="text-text-tertiary">{{ t(`${KEY}.label`) }}</dt>
					<dd class="break-words">{{ details.labelName }}</dd>
				</template>
			</template>
		</dl>
		<template v-if="isMessage && details && !isDraftGone && !isInaccessible">
			<p v-if="hasHiddenContent" data-test="hidden-content" class="mt-3 font-medium text-error">
				{{ t(`${KEY}.hiddenContent`) }}
			</p>
			<div class="@container">
				<div :class="html ? 'grid gap-3 @2xl:grid-cols-2' : ''">
					<div v-if="html">
						<p class="mt-3 text-xs text-text-tertiary">{{ t(`${KEY}.previewHint`) }}</p>
						<!-- palette-ok: the recipient's paper, not our chrome; the message
						     brings its own colours, so the frame stays white in either theme. -->
						<iframe
							:srcdoc="previewSrcdoc"
							sandbox=""
							referrerpolicy="no-referrer"
							data-test="html-preview"
							:title="t(`${KEY}.preview`)"
							class="mt-2 h-56 w-full rounded border border-border-subtle bg-white"
						/>
					</div>
					<!-- The whole body, never a clip: it is what approval sends. Focusable so a
					     keyboard can scroll it. -->
					<div v-if="'body' in details && details.body">
						<p v-if="html" data-test="full-text-hint" class="mt-3 text-xs text-text-tertiary">
							{{ t(`${KEY}.fullTextHint`) }}
						</p>
						<p
							role="region"
							tabindex="0"
							:aria-label="html ? t(`${KEY}.fullText`) : t(`${KEY}.body`)"
							data-test="body"
							class="whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-base p-3 text-text-secondary overflow-y-auto"
							:class="html ? 'mt-2 h-56' : 'mt-3 max-h-48'"
						>
							{{ details.body }}
						</p>
					</div>
				</div>
			</div>
			<!-- The text/plain part goes out too; shown when it says something else. -->
			<p
				v-if="'plainTextBody' in details && details.plainTextBody"
				role="region"
				tabindex="0"
				:aria-label="t(`${KEY}.plainTextBody`)"
				data-test="plain-text-body"
				class="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-base p-3 text-text-secondary"
			>
				{{ details.plainTextBody }}
			</p>
			<!-- AMP-capable clients show the AMP part instead of the HTML part. -->
			<p
				v-if="'ampBody' in details && details.ampBody"
				role="region"
				tabindex="0"
				:aria-label="t(`${KEY}.ampBody`)"
				data-test="amp-body"
				class="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-base p-3 text-text-secondary"
			>
				{{ details.ampBody }}
			</p>
			<!-- A preview shows a link's text, never where it goes: every target, as sent. -->
			<section
				v-if="linkGroups.length > 0"
				role="region"
				tabindex="0"
				:aria-label="t(`${KEY}.links`)"
				data-test="links"
				class="mt-3 max-h-40 overflow-y-auto rounded border border-border-subtle bg-bg-base p-3"
			>
				<h4 class="text-xs font-medium text-text-tertiary">{{ t(`${KEY}.links`) }}</h4>
				<div v-for="group in linkGroups" :key="group.part" class="mt-2 first:mt-1">
					<p v-if="linkGroups.length > 1" class="text-xs text-text-tertiary">
						{{ t(`${KEY}.linkParts.${group.part}`) }}
					</p>
					<ul class="space-y-1.5">
						<li v-for="(link, index) in group.links" :key="index" class="text-xs">
							<p v-if="link.text !== undefined" class="break-words text-text-secondary">
								{{ link.text || t(`${KEY}.linkNoText`) }}
							</p>
							<p class="break-all font-mono text-text-primary">{{ link.href }}</p>
							<p v-if="link.shownHost" data-test="link-mismatch" class="font-medium text-error">
								{{
									t(`${KEY}.linkMismatch`, {
										shown: link.shownHost,
										target: link.host ?? link.href,
									})
								}}
							</p>
						</li>
					</ul>
				</div>
			</section>
		</template>
		<p v-if="notice" role="alert" class="mt-3 text-error">{{ notice }}</p>

		<footer class="mt-4 flex items-center justify-end gap-2">
			<UiButton variant="ghost" type="button" :disabled="busy" @click="emit('reject')">
				{{ t(`${KEY}.reject`) }}
			</UiButton>
			<UiButton type="button" :disabled="!canApprove" :loading="busy" @click="approve">
				{{ action.tool === 'send_draft' ? t(`${KEY}.approveSend`) : t(`${KEY}.approve`) }}
			</UiButton>
		</footer>
	</article>
</template>
