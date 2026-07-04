<script setup lang="ts">
/**
 * "Coach my draft" panel — the middle rung between "suggest a reply" and
 * "auto-draft" for high-stakes (money / legal / bad-news) mail people will not
 * hand to an AI.
 *
 * A single button runs the SAME draft-quality self-check the agent runs on its
 * own drafts, but over the USER's own text (`mail.ai.coachDraft`), and lists the
 * critique inline — tone, ambiguity, clarity, a missing answer. It NEVER
 * rewrites or replaces the draft; the user stays the author. Advisory + fail
 * soft: an empty result renders "Looks solid" and any error is a silent no-op
 * (a toast, draft untouched).
 *
 * Self-contained so it can drop into both the Postbox composer and the agent
 * review gate: it owns the Convex call and the pure {@link usePostboxCoach}
 * lifecycle. The whole surface is hidden when `enabled` (the `ai` flag) is off
 * or the draft is too short to coach.
 */

import { computed } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	usePostboxCoach,
	isCoachEligible,
	COACH_CATEGORY_LABELS,
	type CoachSuggestion,
} from '~/composables/postbox/usePostboxCoach';

const props = defineProps<{
	/** The user's own draft text to critique. */
	draftText: string;
	/** True when the AI `ai` flag is on for this org/user. */
	enabled: boolean;
	/** Optional owned thread whose messages become read-only critique context. */
	messageId?: Id<'mailMessages'>;
	/** Optional free-text inbound context when there is no thread id to hand. */
	threadContext?: string;
}>();

const { showToast } = useToast();

const coach = usePostboxCoach({
	requestCoach: async (draftText, signal): Promise<CoachSuggestion[]> => {
		const res = await requireConvex().action(api.mail.ai.coachDraft, {
			draftText,
			...(props.messageId ? { messageId: props.messageId } : {}),
			...(props.threadContext ? { threadContext: props.threadContext } : {}),
		});
		if (signal.aborted) return [];
		return res?.suggestions ?? [];
	},
	onError: (message) => {
		showToast(message, 'error');
	},
});

/** The Coach action only shows when AI is on AND the draft is worth coaching. */
const eligible = computed(() => isCoachEligible(props.enabled, props.draftText));

function onCoachClick() {
	if (!eligible.value) return;
	void coach.run(props.draftText);
}

/** Per-category dot colour, purely decorative. */
const CATEGORY_DOT: Record<string, string> = {
	tone: 'bg-brand',
	ambiguity: 'bg-warning',
	clarity: 'bg-info',
	'missing-answer': 'bg-error',
};
</script>

<template>
	<div v-if="eligible" class="mt-2" data-testid="postbox-coach">
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="btn btn-ghost btn-sm gap-1"
				:disabled="coach.isLoading()"
				data-testid="postbox-coach-run"
				@click="onCoachClick"
			>
				<Icon
					v-if="coach.isLoading()"
					name="lucide:loader-2"
					class="w-3.5 h-3.5 animate-spin"
				/>
				<Icon v-else name="lucide:graduation-cap" class="w-3.5 h-3.5" />
				<span>Coach my draft</span>
			</button>
			<span class="text-xs text-text-tertiary">Reviews your wording — never rewrites it.</span>
		</div>

		<!-- Clean draft: nothing to flag. -->
		<p
			v-if="coach.isClean()"
			class="mt-2 flex items-center gap-1.5 text-xs text-success"
			data-testid="postbox-coach-clean"
		>
			<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5" />
			Looks solid — no issues found.
		</p>

		<!-- Advisory critique of the user's OWN text. Never replaces the draft. -->
		<ul
			v-else-if="coach.isReady()"
			class="mt-2 space-y-1.5"
			data-testid="postbox-coach-suggestions"
		>
			<li
				v-for="(s, i) in coach.suggestions.value"
				:key="i"
				class="flex items-start gap-2 text-xs"
			>
				<span
					class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
					:class="CATEGORY_DOT[s.category] ?? 'bg-info'"
				/>
				<span>
					<span class="font-medium text-text-secondary">{{ COACH_CATEGORY_LABELS[s.category] }}:</span>
					<span class="text-text-secondary"> {{ s.message }}</span>
				</span>
			</li>
		</ul>
	</div>
</template>
