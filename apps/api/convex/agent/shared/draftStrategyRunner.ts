'use node';

import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { LlmTextResult } from '../../lib/llm/dispatch';
import { runHostedDraftStrategy } from './draftStrategyHost';

interface StrategySelectionScope {
	readonly mailboxId?: string;
	readonly contactId?: string;
	readonly classification: string;
}

interface StrategySource {
	readonly audience: 'organization' | 'personal';
	readonly context: string;
	readonly confirmedContext?: string;
	readonly stanceGuidance?: string;
	readonly classification: {
		readonly category: string;
		readonly intent: string;
		readonly sentiment: string;
		readonly priority: string;
	};
	readonly toneInstruction: string;
	readonly signatureInstruction: string;
	readonly voiceSection: string;
}

export async function runSelectedDraftStrategy(
	ctx: ActionCtx,
	scope: StrategySelectionScope | undefined,
	source: StrategySource,
	runDefault: () => Promise<LlmTextResult>
): Promise<{
	draftBody: string;
	tokenUsage: LlmTextResult['tokenUsage'];
	modelUsed: LlmTextResult['modelUsed'];
}> {
	const strategyKind = scope
		? await ctx
				.runQuery(internal.plugins.draftStrategySelections.resolveForDraft, scope)
				.catch(() => 'default')
		: 'default';
	if (strategyKind !== 'default') {
		const customDraft = await runHostedDraftStrategy(ctx, strategyKind, source);
		if (customDraft !== null)
			return { draftBody: customDraft, tokenUsage: undefined, modelUsed: undefined };
	}
	const generated = await runDefault();
	return {
		draftBody: generated.text,
		tokenUsage: generated.tokenUsage,
		modelUsed: generated.modelUsed,
	};
}
