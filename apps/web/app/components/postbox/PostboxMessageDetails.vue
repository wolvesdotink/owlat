<script setup lang="ts">
/**
 * "Message details" disclosure in the reader header (UX plan idea 52).
 *
 * The sender badge makes a claim — "verified sender" — that a reader has had no
 * way to check, which is at odds with an app that audits its own honesty. This
 * is the falsifiable half: the addresses the message carries, every
 * authentication verdict WITH the domain it actually authenticated, the
 * forwarder whose ARC seal rescued a failing message, and a download of the
 * original `.eml` for anyone who wants to read the raw headers themselves.
 *
 * Collapsed by default and SKIPPED while collapsed: the header query only
 * subscribes once the panel is opened, so a reader who never asks pays nothing.
 * Row derivation lives in `utils/postboxMessageDetails.ts` (pure, unit-tested);
 * this component fetches, resolves keys and renders.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { buildMessageDetailRows, type MessageDetailTone } from '~/utils/postboxMessageDetails';

const props = defineProps<{ messageId: string }>();

const { t } = useI18n();
const { showToast } = useToast();

const expanded = ref(false);

// 'skip' while collapsed — the panel is a disclosure, not a preload.
const { data: details, isLoading } = useConvexQuery(
	api.mail.mailbox.messages.getMessageDetails,
	() => (expanded.value ? { messageId: props.messageId as Id<'mailMessages'> } : ('skip' as const))
);

const rows = computed(() => (details.value ? buildMessageDetailRows(details.value) : []));

/** Chip styling per outcome. FF tokens only, matching the sender badge's tones. */
const TONE_CLASSES: Record<MessageDetailTone, string> = {
	pass: 'border-success/40 text-success',
	fail: 'border-error/40 text-error',
	warn: 'border-warning/40 text-warning',
	neutral: 'border-border-subtle text-text-secondary',
};

// A fresh message means a fresh panel: leaving it open across a thread switch
// would show one message's headers under another's subject for a beat.
watch(
	() => props.messageId,
	() => (expanded.value = false)
);

const downloading = ref(false);

/**
 * Download the original `.eml`. The bytes come from the same signed-URL path the
 * attachment extractor uses, decoded latin1 (one char per byte), so the file on
 * disk is the message exactly as it arrived — headers included.
 */
async function downloadOriginal() {
	downloading.value = true;
	try {
		const raw = await loadRawEml(props.messageId);
		if (!raw) {
			showToast(t('components.postbox.postboxMessageDetails.downloadFailed'), 'error');
			return;
		}
		const bytes = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
		const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'message/rfc822' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'message.eml';
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	} catch {
		showToast(t('components.postbox.postboxMessageDetails.downloadFailed'), 'error');
	} finally {
		downloading.value = false;
	}
}
</script>

<template>
	<div class="mt-2" data-testid="message-details">
		<button
			type="button"
			class="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
			:aria-expanded="expanded"
			data-testid="message-details-toggle"
			@click="expanded = !expanded"
		>
			{{ t('components.postbox.postboxMessageDetails.toggle') }}
			<Icon :name="expanded ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="w-3 h-3" />
		</button>
		<div
			v-if="expanded"
			class="mt-2 p-3 rounded border border-border-subtle bg-bg-surface text-xs"
			data-testid="message-details-panel"
		>
			<p v-if="isLoading" class="text-text-tertiary" role="status">
				{{ t('components.postbox.postboxMessageDetails.loading') }}
			</p>
			<!-- No rows is a real state (a legacy row with no verdicts and no
			     Reply-To): say so rather than render an empty card. -->
			<p v-else-if="rows.length === 0" class="text-text-tertiary">
				{{ t('components.postbox.postboxMessageDetails.empty') }}
			</p>
			<dl v-else class="space-y-1.5">
				<div
					v-for="row in rows"
					:key="row.id"
					class="flex items-baseline gap-2"
					:data-testid="`message-details-row-${row.id}`"
				>
					<dt class="w-20 flex-shrink-0 text-text-tertiary">{{ t(row.label) }}</dt>
					<dd class="min-w-0 flex-1 flex items-baseline gap-1.5 flex-wrap">
						<span
							v-if="row.verdict"
							class="inline-flex items-center px-1.5 py-0.5 rounded border font-medium"
							:class="TONE_CLASSES[row.tone]"
							data-testid="message-details-verdict"
						>
							{{ row.verdict }}
						</span>
						<span
							v-if="row.value"
							class="text-text-primary break-all"
							:class="{ 'text-warning': !row.verdict && row.tone === 'warn' }"
							>{{ row.value }}</span
						>
						<span v-if="row.note" class="text-text-tertiary">{{ t(row.note) }}</span>
					</dd>
				</div>
			</dl>
			<div class="mt-3 pt-2 border-t border-border-subtle">
				<button
					type="button"
					class="text-brand hover:underline disabled:opacity-60"
					:disabled="downloading"
					data-testid="message-details-download"
					@click="downloadOriginal"
				>
					{{
						downloading
							? t('components.postbox.postboxMessageDetails.downloading')
							: t('components.postbox.postboxMessageDetails.download')
					}}
				</button>
			</div>
		</div>
	</div>
</template>
