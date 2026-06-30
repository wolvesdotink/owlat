<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractAttachmentAt } from '@owlat/shared/mailMime';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import {
	classifySecureMessage,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';

const props = defineProps<{
	message: {
		_id: string;
		mailboxId: string;
		threadId?: string;
		fromAddress: string;
		fromName?: string;
		toAddresses: string[];
		ccAddresses: string[];
		subject: string;
		receivedAt: number;
		htmlBodyInline?: string;
		textBodyInline?: string;
		hasAttachments: boolean;
		attachments: Array<{
			filename: string;
			contentType: string;
			size: number;
			partIndex?: string;
			contentId?: string;
		}>;
		spamVerdict?: string;
		dmarcResult?: string;
		flagSeen?: boolean;
	};
}>();

const stack = usePostboxComposerStack();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// The mailbox's own addresses (canonical + active aliases) — excluded from the
// Cc set on Reply-All so the user never adds themselves.
const ownIdentitiesQuery = useConvexQuery(
	api.mail.identities.listForOwnedMailbox,
	() => ({ mailboxId: props.message.mailboxId as Id<'mailboxes'> })
);

/** Strip "Name <addr>" framing and lowercase, for dedupe/exclusion compares. */
function canonicalEmail(raw: string): string {
	const m = raw.match(/<([^>]+)>/);
	return (m?.[1] ?? raw).trim().toLowerCase();
}

const ownAddresses = computed(
	() =>
		new Set(
			((ownIdentitiesQuery.data.value as string[] | undefined) ?? []).map(canonicalEmail)
		)
);
const ownEmail = computed(() => (ownIdentitiesQuery.data.value as string[] | undefined)?.[0]);

// PGP/S-MIME structure per message (detection only — see PostboxSecurityBadge),
// classified once per thread change rather than on every template re-render.
const secureClassMap = computed(() => {
	const map = new Map<string, SecureMessageClass>();
	for (const m of allMessages.value) {
		map.set(m._id, classifySecureMessage({ attachments: m.attachments, textBody: m.textBodyInline }));
	}
	return map;
});
function secureClass(msg: { _id: string }): SecureMessageClass {
	return secureClassMap.value.get(msg._id) ?? 'none';
}
/** Hide the raw body when it's encrypted (gibberish) or clearsigned (the badge
 * shows the readable cleartext instead). */
function hideRawBody(msg: { _id: string }): boolean {
	const c = secureClass(msg);
	return isEncryptedClass(c) || c === 'pgp-clearsigned';
}

/** The text/calendar (.ics) attachment of a message, if it carries an invite. */
function calendarAttachment(msg: {
	attachments: Array<{ filename: string; contentType: string; partIndex?: string }>;
}) {
	return msg.attachments?.find(
		(a) =>
			a.contentType.toLowerCase().includes('calendar') ||
			a.filename.toLowerCase().endsWith('.ics')
	);
}

const messageId = computed(() => props.message._id as Id<'mailMessages'>);
const { data: threadData, isLoading } = useConvexQuery(
	api.mail.mailbox.listThreadMessages,
	() => ({ messageId: messageId.value })
);

const allMessages = computed(() => threadData.value?.messages ?? [props.message]);
const latestMessage = computed(() => allMessages.value[allMessages.value.length - 1]);
const labelMap = computed(() => {
	const map = new Map<string, { _id: string; name: string; color?: string }>();
	for (const l of threadData.value?.labels ?? []) map.set(l._id, l);
	return map;
});
const threadLabels = computed(() => threadData.value?.thread?.labelIds ?? []);

// Mark-as-read on open (Gmail conversation-view semantics): the first time an
// unread thread is opened, clear its unread flags. Guarded so the reactive
// re-fetch that follows (flagSeen flips → query re-runs) doesn't re-fire.
const markThreadReadOp = useBackendOperation(api.mail.messageActions.markThreadRead, {
	label: 'Mark read',
});
const markedThreads = new Set<string>();
watch(
	() => threadData.value,
	(data) => {
		const thread = data?.thread;
		if (!thread) return;
		if (markedThreads.has(thread._id)) return;
		const hasUnread = (data?.messages ?? []).some((m) => !m.flagSeen);
		if (!hasUnread) return;
		markedThreads.add(thread._id);
		void markThreadReadOp.run({
			threadId: thread._id as Id<'mailThreads'>,
			seen: true,
		});
	},
	{ immediate: true }
);

const expanded = ref<Set<string>>(new Set());

watch(
	allMessages,
	(messages) => {
		if (messages.length === 0) {
			expanded.value = new Set();
			return;
		}
		const next = new Set<string>();
		const last = messages[messages.length - 1];
		if (last) next.add(last._id);
		// Show first message too if more than 2
		const first = messages[0];
		if (messages.length > 2 && first) next.add(first._id);
		// Show all unread
		for (const m of messages) if (!m.flagSeen) next.add(m._id);
		// Always include the active message
		next.add(props.message._id);
		expanded.value = next;
	},
	{ immediate: true }
);

function toggleExpanded(id: string) {
	const next = new Set(expanded.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expanded.value = next;
}

function formatTime(ts: number) {
	return new Date(ts).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

type ReplyForwardSource = {
	_id: string;
	subject: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
};

/**
 * Resolve the original body for quoting. Messages over ~64KB store their body
 * in blob storage with empty inline fields, so Reply/Forward would quote an
 * empty original — fetch the full body in that case (the same source
 * PostboxMessageBody renders from). Falls back to the row on any error so the
 * composer always opens.
 */
async function resolveBodyFields(t: ReplyForwardSource): Promise<ReplyForwardSource> {
	if (t.htmlBodyInline || t.textBodyInline) return t;
	try {
		const data = await requireConvex().query(api.mail.mailbox.getMessageBody, {
			messageId: t._id as Id<'mailMessages'>,
		});
		if (!data) return t;
		let html = data.htmlInline ?? undefined;
		let text = data.textInline ?? undefined;
		if (!html && data.htmlUrl) html = await (await fetch(data.htmlUrl)).text();
		else if (!text && data.textUrl) text = await (await fetch(data.textUrl)).text();
		return { ...t, htmlBodyInline: html, textBodyInline: text };
	} catch {
		return t;
	}
}

async function openReply(replyTo?: ReplyForwardSource) {
	const target = await resolveBodyFields(replyTo ?? props.message);
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillSubject: target.subject.match(/^re\s*:\s*/i)
			? target.subject
			: `Re: ${target.subject}`,
		prefillBodyHtml: buildQuotedReply(target),
	});
}

async function openReplyAll(replyTo?: ReplyForwardSource) {
	const target = await resolveBodyFields(replyTo ?? props.message);
	const seen = new Set<string>([canonicalEmail(target.fromAddress), ...ownAddresses.value]);
	const cc: string[] = [];
	for (const addr of [...target.toAddresses, ...target.ccAddresses]) {
		const canon = canonicalEmail(addr);
		if (!canon || seen.has(canon)) continue;
		seen.add(canon);
		cc.push(addr);
	}
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillCc: cc,
		prefillSubject: target.subject.match(/^re\s*:\s*/i)
			? target.subject
			: `Re: ${target.subject}`,
		prefillBodyHtml: buildQuotedReply(target),
	});
}

/** Whether Reply-All would add anyone beyond a plain Reply (extra To/Cc). */
function hasOtherRecipients(msg: { fromAddress: string; toAddresses: string[]; ccAddresses: string[] }) {
	const seen = new Set<string>([canonicalEmail(msg.fromAddress), ...ownAddresses.value]);
	return [...msg.toAddresses, ...msg.ccAddresses].some((a) => {
		const c = canonicalEmail(a);
		return c.length > 0 && !seen.has(c);
	});
}

/** Open a reply seeded with an AI-suggested body (above the quoted original). */
async function openReplyWithBody(replyTarget: ReplyForwardSource, bodyText: string) {
	const target = await resolveBodyFields(replyTarget);
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		inReplyToMessageId: target._id as Id<'mailMessages'>,
		prefillTo: [target.fromAddress],
		prefillSubject: target.subject.match(/^re\s*:\s*/i)
			? target.subject
			: `Re: ${target.subject}`,
		prefillBodyHtml: `<p>${escapeHtmlWithBreaks(bodyText)}</p>${buildQuotedReply(target)}`,
	});
}

async function openForward(msg?: ReplyForwardSource) {
	const target = await resolveBodyFields(msg ?? props.message);
	stack.open({
		mailboxId: props.message.mailboxId as Id<'mailboxes'>,
		prefillSubject: target.subject.match(/^fwd?\s*:\s*/i)
			? target.subject
			: `Fwd: ${target.subject}`,
		prefillBodyHtml: buildForwardedBody(target),
		forwardAttachmentsFromMessageId: target._id as Id<'mailMessages'>,
	});
}

const reportSpamOp = useBackendOperation(api.mail.messageActions.reportSpam, {
	label: 'Report spam',
});
const blockSenderOp = useBackendOperation(api.mail.messageActions.blockSender, {
	label: 'Block sender',
});

function reportSpamMessage(msgId: string) {
	void reportSpamOp.run({ messageIds: [msgId as Id<'mailMessages'>] });
}

function blockSenderOf(msgId: string) {
	void blockSenderOp.run({ messageId: msgId as Id<'mailMessages'> });
}

const downloadingAttachment = ref<string | null>(null);

function isPreviewable(contentType: string): boolean {
	return contentType.startsWith('image/') || contentType === 'application/pdf';
}

/** Fetch the raw .eml, extract the part client-side, then download or preview. */
async function handleAttachment(
	messageId: string,
	att: { filename: string; contentType: string; partIndex?: string },
	mode: 'download' | 'preview'
) {
	const key = `${messageId}:${att.partIndex ?? att.filename}`;
	downloadingAttachment.value = key;
	try {
		const bin = await loadRawEml(messageId);
		if (!bin) return;
		const extracted = extractAttachmentAt(bin, att.partIndex ?? '0', att.filename);
		if (!extracted) return;
		const blob = new Blob([extracted.bytes as BlobPart], {
			type: extracted.contentType || att.contentType,
		});
		const objectUrl = URL.createObjectURL(blob);
		if (mode === 'preview') {
			window.open(objectUrl, '_blank', 'noopener');
		} else {
			const a = document.createElement('a');
			a.href = objectUrl;
			a.download = att.filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
		}
		setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
	} catch {
		// Network/extraction failure — silently no-op (the row stays available).
	} finally {
		downloadingAttachment.value = null;
	}
}
</script>

<template>
	<article class="p-6 max-w-4xl mx-auto">
		<header class="mb-4">
			<h1 class="text-2xl font-semibold text-text-primary">
				{{ message.subject || '(no subject)' }}
			</h1>
			<div
				v-if="threadLabels.length > 0"
				class="mt-2 flex flex-wrap items-center gap-1.5"
			>
				<span
					v-for="labelId in threadLabels"
					:key="labelId"
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
					:style="{
						backgroundColor: (labelMap.get(labelId)?.color || '#6b7280') + '20',
						color: labelMap.get(labelId)?.color || '#6b7280',
					}"
				>
					<span
						class="w-1.5 h-1.5 rounded-full"
						:style="{ backgroundColor: labelMap.get(labelId)?.color || '#6b7280' }"
					/>
					{{ labelMap.get(labelId)?.name }}
				</span>
			</div>
		</header>

		<div v-if="isLoading" class="flex justify-center py-6">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<div v-else class="space-y-2">
			<template v-for="msg in allMessages" :key="msg._id">
				<!-- Collapsed message header -->
				<button
					v-if="!expanded.has(msg._id)"
					type="button"
					class="w-full flex items-center gap-3 px-3 py-2 rounded border border-border-subtle bg-bg-surface text-left hover:bg-bg-elevated"
					@click="toggleExpanded(msg._id)"
				>
					<div
						class="w-7 h-7 rounded-full bg-brand-subtle text-brand flex items-center justify-center text-xs font-semibold flex-shrink-0"
					>
						{{ (msg.fromName || msg.fromAddress).charAt(0).toUpperCase() }}
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm truncate">
							<span class="font-medium">{{ msg.fromName || msg.fromAddress }}</span>
							<span class="text-text-tertiary mx-1.5">·</span>
							<span class="text-text-tertiary">{{ msg.subject }}</span>
						</p>
					</div>
					<span class="text-xs text-text-tertiary flex-shrink-0">
						{{ formatTime(msg.receivedAt) }}
					</span>
				</button>

				<!-- Expanded message -->
				<section
					v-else
					class="border border-border-subtle rounded bg-bg-surface px-4 py-3"
				>
					<header class="flex items-start gap-3">
						<div
							class="w-9 h-9 rounded-full bg-brand-subtle text-brand flex items-center justify-center font-semibold flex-shrink-0"
						>
							{{ (msg.fromName || msg.fromAddress).charAt(0).toUpperCase() }}
						</div>
						<div class="flex-1 min-w-0">
							<div class="flex items-baseline justify-between gap-3">
								<div>
									<span class="font-medium text-text-primary">
										{{ msg.fromName || msg.fromAddress }}
									</span>
									<span v-if="msg.fromName" class="text-text-tertiary text-sm">
										&lt;{{ msg.fromAddress }}&gt;
									</span>
								</div>
								<button
									type="button"
									class="text-xs text-text-tertiary hover:text-text-primary"
									@click="toggleExpanded(msg._id)"
								>
									{{ formatTime(msg.receivedAt) }}
								</button>
							</div>
							<p class="text-text-secondary text-xs mt-0.5">
								to {{ msg.toAddresses.join(', ') }}
								<span v-if="msg.ccAddresses.length > 0">
									· cc {{ msg.ccAddresses.join(', ') }}
								</span>
							</p>
						</div>
					</header>

					<div
						v-if="msg.spamVerdict === 'spam' || msg.dmarcResult === 'fail'"
						class="my-3 px-3 py-2 rounded bg-warning/10 text-warning text-xs flex items-center gap-2"
					>
						<Icon name="lucide:shield-alert" class="w-4 h-4" />
						<span v-if="msg.spamVerdict === 'spam'">Marked as spam</span>
						<span v-else-if="msg.dmarcResult === 'fail'">Failed DMARC verification</span>
					</div>

					<PostboxSecurityBadge
						v-if="secureClass(msg) !== 'none'"
						:klass="secureClass(msg)"
						:message="msg"
					/>
					<PostboxMessageBody v-if="!hideRawBody(msg)" :message="msg" />

						<PostboxInviteCard
							v-if="calendarAttachment(msg)"
							:message-id="msg._id"
							:mailbox-id="message.mailboxId"
							:own-email="ownEmail"
						/>

					<section v-if="msg.attachments?.length > 0" class="mt-3">
						<ul class="grid grid-cols-1 sm:grid-cols-2 gap-2">
							<li
								v-for="(att, i) in msg.attachments"
								:key="i"
								class="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle"
							>
								<Icon name="lucide:paperclip" class="w-4 h-4 text-text-tertiary flex-shrink-0" />
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm">{{ att.filename }}</p>
									<p class="text-xs text-text-tertiary">
										{{ formatCompactFileSize(att.size) }} · {{ att.contentType }}
									</p>
								</div>
								<button
									v-if="isPreviewable(att.contentType)"
									type="button"
									class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
									:title="`Preview ${att.filename}`"
									:aria-label="`Preview ${att.filename}`"
									@click="handleAttachment(msg._id, att, 'preview')"
								>
									<Icon name="lucide:eye" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary disabled:opacity-50"
									:title="`Download ${att.filename}`"
									:aria-label="`Download ${att.filename}`"
									:disabled="downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}`"
									@click="handleAttachment(msg._id, att, 'download')"
								>
									<Icon
										:name="downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}` ? 'lucide:loader-2' : 'lucide:download'"
										class="w-4 h-4"
										:class="{ 'animate-spin': downloadingAttachment === `${msg._id}:${att.partIndex ?? att.filename}` }"
									/>
								</button>
							</li>
						</ul>
					</section>

					<div class="mt-4 flex items-center gap-2">
						<button
							type="button"
							class="btn btn-ghost"
							@click="openReply(msg)"
						>
							<Icon name="lucide:reply" class="w-4 h-4 mr-1.5" />
							Reply
						</button>
						<button
							v-if="hasOtherRecipients(msg)"
							type="button"
							class="btn btn-ghost"
							@click="openReplyAll(msg)"
						>
							<Icon name="lucide:reply-all" class="w-4 h-4 mr-1.5" />
							Reply all
						</button>
						<button
							type="button"
							class="btn btn-ghost"
							@click="openForward(msg)"
						>
							<Icon name="lucide:forward" class="w-4 h-4 mr-1.5" />
							Forward
						</button>
						<span class="flex-1" />
						<button
							type="button"
							class="btn btn-ghost text-text-tertiary"
							title="Report spam"
							aria-label="Report spam"
							@click="reportSpamMessage(msg._id)"
						>
							<Icon name="lucide:shield-alert" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="btn btn-ghost text-text-tertiary"
							title="Block sender"
							aria-label="Block sender"
							@click="blockSenderOf(msg._id)"
						>
							<Icon name="lucide:ban" class="w-4 h-4" />
						</button>
					</div>
				</section>
			</template>

			<PostboxAiAssist
				v-if="latestMessage && isFeatureEnabled('ai')"
				:message-id="latestMessage._id"
				@use-reply="(t) => latestMessage && openReplyWithBody(latestMessage, t)"
			/>
		</div>
	</article>
</template>
