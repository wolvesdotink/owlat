<script setup lang="ts">
/**
 * The team's internal notes and the system lines that follow one email of a
 * shared-mailbox thread (or come before the first one shown), placed between
 * the reader's messages by `usePostboxTeamStream`.
 *
 * The `leading` one also says what of the stream is not loaded yet: older
 * notes still loading, a walk that stopped short of the messages shown
 * ("Some older team notes are not loaded yet") or more before the first
 * message shown, each with the way to load them.
 */
import type { TeamStreamEntry } from '../../../../api/convex/mail/interpret/briefShape';
import type { PostboxTeamStream } from '~/composables/postbox/usePostboxTeamStream';
import TeamThreadStream from '~/components/team/TeamThreadStream.vue';

defineProps<{
	state: PostboxTeamStream;
	entries: readonly TeamStreamEntry[];
	leading?: boolean;
}>();

const { t } = useI18n();
</script>

<template>
	<template v-if="state.isActive.value">
		<p
			v-if="leading && state.earlier.value !== 'none'"
			role="status"
			class="flex flex-wrap items-center justify-center gap-2 py-1 text-xs text-text-secondary"
			data-testid="team-stream-earlier-state"
			:data-state="state.earlier.value"
		>
			<span v-if="state.earlier.value === 'loading'">{{
				t('components.team.stream.loadingEarlier')
			}}</span>
			<template v-else>
				<span v-if="state.earlier.value === 'cut'">{{ t('components.team.stream.cut') }}</span>
				<UiButton
					variant="ghost"
					size="sm"
					data-testid="team-stream-earlier"
					@click="state.loadEarlier()"
				>
					<Icon name="lucide:chevrons-up" class="size-3.5" />
					{{ t('components.team.stream.earlierNotes') }}
				</UiButton>
			</template>
		</p>
		<TeamThreadStream
			v-if="entries.length > 0"
			class="py-1"
			:entries="entries"
			:viewer-id="state.team.viewerId.value"
			:member-name="state.team.memberName"
			:can-react="state.notesEnabled.value"
			@react-note="state.team.reactNote"
		/>
	</template>
</template>
