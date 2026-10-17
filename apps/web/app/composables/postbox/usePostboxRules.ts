/**
 * Plain-language rules (read on arrival, SPEC §6.1, §6.2): compile the
 * person's sentence into a draft the section subscribes to, confirm or drop
 * it, and test a draft or saved rule on recent mail.
 *
 * Compiling is asynchronous: `mail.filterCompile.compile` writes a
 * `mailRuleDrafts` row that shows `compiling`, then `ready` with a preview or
 * `failed`; `recentDrafts` is the live view of those rows.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import type { MailFilterCondition, FilterMatchType } from '~/composables/postbox/usePostboxFilters';

export type RuleDryRunResult = FunctionReturnType<typeof api.mail.rules.dryRun.testRule>;
export type RuleDraftRow = FunctionReturnType<
	typeof api.mail.filterCompileStore.recentDrafts
>[number];

/** A filter that runs in the arrival hook: written in plain language, by a Fix, or with an AI condition. */
export function isPlainLanguageRule(filter: {
	origin?: string;
	aiCondition?: { question: string };
}): boolean {
	return (filter.origin !== undefined && filter.origin !== 'manual') || !!filter.aiCondition;
}

export function usePostboxRules(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data, error } = useConvexQuery(api.mail.filterCompileStore.recentDrafts, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const drafts = computed(() => data.value ?? []);

	const compileOp = useBackendOperation(api.mail.filterCompile.compile, {
		label: () => t('postbox.rules.operations.compile'),
		type: 'action',
	});
	const confirmOp = useBackendOperation(api.mail.filterCompileStore.confirm, {
		label: () => t('postbox.rules.operations.confirm'),
	});
	const discardOp = useBackendOperation(api.mail.filterCompileStore.discard, {
		label: () => t('postbox.rules.operations.discard'),
	});
	const testOp = useBackendOperation(api.mail.rules.dryRun.testRule, {
		label: () => t('postbox.rules.operations.test'),
		type: 'action',
	});

	async function compile(sourceText: string): Promise<boolean> {
		if (!mailboxId.value) return false;
		return (await compileOp.run({ mailboxId: mailboxId.value, sourceText })).ok;
	}

	async function confirm(draftId: Id<'mailRuleDrafts'>): Promise<boolean> {
		return (await confirmOp.run({ draftId })).ok;
	}

	async function discard(draftId: Id<'mailRuleDrafts'>): Promise<void> {
		await discardOp.run({ draftId });
	}

	/** Test a saved rule (`filterId`) or a draft preview on the newest 50 Inbox mails. */
	async function test(
		rule:
			| { filterId: Id<'mailFilters'> }
			| {
					draft: {
						conditions: MailFilterCondition[];
						matchType?: FilterMatchType;
						aiQuestion?: string;
					};
			  }
	): Promise<RuleDryRunResult | null> {
		if (!mailboxId.value) return null;
		const outcome = await testOp.run({ mailboxId: mailboxId.value, ...rule });
		return outcome.ok ? outcome.result : null;
	}

	return {
		drafts,
		error,
		compile,
		confirm,
		discard,
		test,
		isCompiling: compileOp.isLoading,
		isTesting: testOp.isLoading,
	};
}
