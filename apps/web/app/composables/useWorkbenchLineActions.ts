import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { Ref } from 'vue';
import { useAnswerModeNav } from '~/composables/useAnswerMode';
import type { TodayChange, TodayLine, TodaySource } from '~/utils/todayDigest';
import { TEAM_SCOPE } from '~/utils/workbench';

/**
 * What a Workbench line can do: "Got it" acknowledges it (a team update is
 * dismissed, a Postbox thread counts as visited), and "Reply anyway" sends a
 * team update to the Answer queue after all. Both hide the line at once
 * through `hidden`, and bring it back when the write fails; the live read
 * confirms the rest.
 */
export function useWorkbenchLineActions(hidden: Ref<Set<string>>) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const answerNav = useAnswerModeNav();
	const { run: recordVisit } = useBackendOperation(api.mail.threadVisits.recordVisit, {
		label: () => t('dashboard.today.operations.done'),
	});
	const { run: dismissUpdate } = useBackendOperation(api.inbox.updates.dismissUpdate, {
		label: () => t('dashboard.today.operations.done'),
	});
	const { run: requestReply } = useBackendOperation(api.inbox.updates.requestReply, {
		label: () => t('dashboard.today.operations.replyAnyway'),
	});

	function unhide(key: string) {
		const next = new Set(hidden.value);
		next.delete(key);
		hidden.value = next;
	}

	async function doneLine(line: TodayLine | TodayChange) {
		hidden.value = new Set([...hidden.value, line.key]);
		const source = line.sources[0];
		let ok = true;
		if ('inboundMessageId' in line && line.inboundMessageId) {
			ok = (
				await dismissUpdate({ inboundMessageId: line.inboundMessageId as Id<'inboundMessages'> })
			).ok;
		} else if (source?.kind === 'mail') {
			ok = (await recordVisit({ threadId: source.threadId as Id<'mailThreads'> })).ok;
		}
		if (!ok) unhide(line.key);
	}

	async function replyAnyway(line: TodayLine, opts: { answer?: TodaySource } = {}) {
		if (!line.inboundMessageId) return;
		hidden.value = new Set([...hidden.value, line.key]);
		const result = await requestReply({
			inboundMessageId: line.inboundMessageId as Id<'inboundMessages'>,
		});
		if (!result.ok) {
			unhide(line.key);
			return;
		}
		// From the peek, the person is about to answer: the reply opens in Answer
		// mode, where the agent's draft lands in the editor.
		const source = opts.answer;
		if (source) {
			void answerNav.openTeam(source.threadId, { messageId: source.id });
			return;
		}
		showToast(t('dashboard.today.replyRequested'), 'success', {
			action: {
				label: t('dashboard.today.openQueue'),
				onAction: () => void navigateTo(`/dashboard/answer?in=${TEAM_SCOPE}`),
			},
		});
	}

	return { doneLine, replyAnyway };
}
