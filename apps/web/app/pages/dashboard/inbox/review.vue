<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Review Queue — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

const { reviewItems, isLoading, needsReply, onApprove, onReject, composeAndSend } = useReviewQueue();

// Action state
const actionInProgress = ref<string | null>(null);

// Per-card compose state for draftless complaint/urgent escalations: the agent
// pipeline skips the drafter for these, so there is no draft to approve — the
// admin types a reply here, which is persisted + sent through edit→approve.
const composeBody = reactive<Record<string, string>>({});
const composeSubject = reactive<Record<string, string>>({});

// Success toast
const { showToast } = useToast();

const onApproveClick = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await onApprove(messageId);
		if (result === undefined) return;
		showToast('Draft approved and queued for sending');
	} finally {
		actionInProgress.value = null;
	}
};

const onRejectClick = async (messageId: Id<'inboundMessages'>) => {
	actionInProgress.value = messageId;
	try {
		const result = await onReject(messageId);
		if (result === undefined) return;
		showToast('Draft rejected');
	} finally {
		actionInProgress.value = null;
	}
};

const onComposeSend = async (messageId: Id<'inboundMessages'>) => {
	const body = composeBody[messageId] ?? '';
	if (body.trim().length === 0) return;
	actionInProgress.value = messageId;
	try {
		const result = await composeAndSend(messageId, body, composeSubject[messageId]);
		if (result === undefined) return;
		delete composeBody[messageId];
		delete composeSubject[messageId];
		showToast('Reply sent');
	} finally {
		actionInProgress.value = null;
	}
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex items-center gap-4 mb-8">
			<NuxtLink
				to="/dashboard/inbox"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</NuxtLink>
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Review Queue</h1>
				<p class="text-text-secondary mt-1">
					Agent-generated drafts and escalations waiting for your action.
				</p>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading review queue...</p>
			</div>
		</div>

		<!-- Empty State -->
		<div
			v-else-if="!reviewItems || reviewItems.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:check-circle" size="xl" variant="success" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">All caught up!</p>
			<p class="text-sm text-text-tertiary mt-1">
				No drafts need your review right now.
			</p>
		</div>

		<!-- Review Items -->
		<div v-else class="space-y-4">
			<div
				v-for="item in reviewItems"
				:key="item.message._id"
				class="card"
			>
				<div class="flex items-start justify-between mb-3">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="full" />
						<div>
							<p class="text-text-primary font-medium text-sm">
								{{ item.message.from }}
							</p>
							<p class="text-xs text-text-tertiary">
								{{ formatCompactRelativeTime(item.message._creationTime) }}
								<template v-if="item.thread">
									&middot;
									<NuxtLink
										:to="`/dashboard/inbox/${item.thread._id}`"
										class="text-brand hover:underline"
									>
										View thread
									</NuxtLink>
								</template>
							</p>
						</div>
					</div>

					<!-- Classification badges -->
					<div v-if="item.message.classification" class="flex items-center gap-2">
						<span
							v-if="needsReply(item.message)"
							class="text-xs px-2 py-0.5 rounded-full bg-warning/10 text-warning font-medium"
						>
							Needs reply
						</span>
						<span class="text-xs px-2 py-0.5 rounded-full bg-brand-subtle text-brand">
							{{ item.message.classification.category }}
						</span>
						<span class="text-xs px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary font-mono">
							{{ Math.round((item.message.classification.confidence ?? 0) * 100) }}%
						</span>
					</div>
				</div>

				<!-- Original message excerpt -->
				<p v-if="item.message.subject" class="text-text-primary font-medium text-sm mb-1">
					{{ item.message.subject }}
				</p>
				<p class="text-text-secondary text-sm mb-4 line-clamp-2">
					{{ item.message.textBody || '(No text content)' }}
				</p>

				<!-- Draftless escalation: compose a reply inline -->
				<template v-if="needsReply(item.message)">
					<div class="bg-warning/5 border border-warning/20 rounded-lg p-4 mb-4">
						<div class="flex items-center gap-2 mb-3">
							<Icon name="lucide:user-round" class="w-4 h-4 text-warning" />
							<p class="text-xs font-medium text-warning uppercase tracking-wider">
								Escalated — write a reply
							</p>
						</div>
						<input
							v-model="composeSubject[item.message._id]"
							type="text"
							class="input w-full text-sm mb-3"
							placeholder="Subject (optional)"
						/>
						<textarea
							v-model="composeBody[item.message._id]"
							rows="6"
							class="input w-full text-sm resize-y"
							placeholder="Type your reply…"
						/>
					</div>

					<!-- Why it was escalated + what the agent had to work from -->
					<InboxDecisionRationale
						:decision="item.message.agentDecision"
						:grounding-sources="item.message.groundingSources"
						class="mb-4"
					/>

					<!-- Actions -->
					<div class="flex items-center gap-2">
						<button
							class="btn btn-primary btn-sm gap-1"
							:disabled="actionInProgress === item.message._id || !(composeBody[item.message._id]?.trim())"
							@click="onComposeSend(item.message._id)"
						>
							<Icon name="lucide:send" class="w-3 h-3" />
							Send Reply
						</button>
						<NuxtLink
							v-if="item.thread"
							:to="`/dashboard/inbox/${item.thread._id}`"
							class="btn btn-secondary btn-sm gap-1"
						>
							<Icon name="lucide:external-link" class="w-3 h-3" />
							Open thread
						</NuxtLink>
						<button
							class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
							:disabled="actionInProgress === item.message._id"
							@click="onRejectClick(item.message._id)"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
							Dismiss
						</button>
					</div>
				</template>

				<!-- Agent draft awaiting approval -->
				<template v-else>
					<div class="bg-brand-subtle/30 rounded-lg p-4 mb-4">
						<div class="flex items-center gap-2 mb-2">
							<Icon name="lucide:bot" class="w-4 h-4 text-brand" />
							<p class="text-xs font-medium text-brand uppercase tracking-wider">Agent Draft</p>
						</div>
						<p class="text-text-primary text-sm whitespace-pre-wrap">
							{{ item.message.draftResponse }}
						</p>
					</div>

					<!-- Why it was held + what it was grounded in (read-only) -->
					<InboxDecisionRationale
						:decision="item.message.agentDecision"
						:grounding-sources="item.message.groundingSources"
						class="mb-4"
					/>

					<!-- Actions -->
					<div class="flex items-center gap-2">
						<button
							class="btn btn-primary btn-sm gap-1"
							:disabled="actionInProgress === item.message._id"
							@click="onApproveClick(item.message._id)"
						>
							<Icon name="lucide:check" class="w-3 h-3" />
							Approve & Send
						</button>
						<NuxtLink
							v-if="item.thread"
							:to="`/dashboard/inbox/${item.thread._id}`"
							class="btn btn-secondary btn-sm gap-1"
						>
							<Icon name="lucide:pencil" class="w-3 h-3" />
							Edit
						</NuxtLink>
						<button
							class="btn btn-ghost btn-sm gap-1 text-error hover:bg-error-subtle"
							:disabled="actionInProgress === item.message._id"
							@click="onRejectClick(item.message._id)"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
							Reject
						</button>
					</div>
				</template>
			</div>
		</div>
	</div>
</template>
