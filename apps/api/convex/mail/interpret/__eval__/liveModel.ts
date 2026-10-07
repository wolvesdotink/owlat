/**
 * The live {@link EvalModel}: the eval's messages through the run's pure core
 * (`../pipeline.ts`, `../prompt.ts`): prompt input, prompt, parse, clamp. The
 * model call itself is injected (`generate`), so this module stays pure and
 * isolate-safe; `apps/api/scripts/interpret-eval.ts` supplies an AI SDK call
 * when a key and a model are configured, and skips the live run otherwise.
 *
 * Each message is interpreted on its own, with no open items from earlier
 * messages (the eval scores extraction and grounding, not the reducer).
 * Participant refs are resolved before the output goes back to the scorer, so
 * it reads `responsible.isUs` as the run's reducer would.
 */

import type { AppLocale } from '@owlat/shared/appLocales';
import type { EvalModel } from './runEval';
import type { EvalParty, EvalThread } from './corpus';
import { buildInterpretInput, clampOutput, resolveParticipant } from '../pipeline';
import { buildInterpretPrompt } from '../prompt';
import {
	interpretOutputSchema,
	interpretOutputSchemaFor,
	type InterpretInputParticipant,
	type InterpretOutput,
} from '../schema';
import { contentRevisionOf } from '../scope';

export type EvalGenerate = (request: {
	prompt: string;
	schema: ReturnType<typeof interpretOutputSchemaFor>;
}) => Promise<{ object: unknown; costUsd?: number }>;

function participantsOf(
	thread: EvalThread,
	message: EvalThread['messages'][number]
): InterpretInputParticipant[] {
	const us = new Set(thread.us.map((u) => u.email.toLowerCase()));
	const list: InterpretInputParticipant[] = [];
	const add = (role: InterpretInputParticipant['role'], party: EvalParty) => {
		const email = party.email.toLowerCase();
		if (list.some((p) => p.email === email)) return;
		const isUs = us.has(email);
		list.push({
			ref: `p${list.length + 1}`,
			role: isUs && role !== 'from' ? 'us' : role,
			email,
			...(party.name ? { name: party.name } : {}),
			isUs,
		});
	};
	add('from', message.from);
	for (const p of message.to) add('to', p);
	for (const p of message.cc ?? []) add('cc', p);
	return list;
}

/** Build the live eval model around an injected model call. */
export function createLiveEvalModel(name: string, generate: EvalGenerate): EvalModel {
	return {
		name,
		async interpret({ thread, message, segmented }) {
			const participants = participantsOf(thread, message);
			const locales: AppLocale[] = ['en', 'de'];
			const input = buildInterpretInput({
				mode: thread.mode,
				segmented,
				sentAt: Date.parse(message.sentAt),
				timezone: 'UTC',
				contentRevision: await contentRevisionOf(segmented),
				participants,
				openItems: [],
				isItemsOverflow: false,
				currentFacts: [],
				isFactsOverflow: false,
				locales,
			});
			const { object, costUsd } = await generate({
				prompt: buildInterpretPrompt(input),
				schema: interpretOutputSchemaFor(thread.mode),
			});
			const output = clampOutput(interpretOutputSchema.parse(object) as InterpretOutput);
			const own = new Set(thread.us.map((u) => u.email.toLowerCase()));
			const resolved = {
				...output,
				items: output.items.map((item) => ({
					...item,
					requester: resolveParticipant(item.requester, participants, own),
					responsible: resolveParticipant(item.responsible, participants, own),
				})),
			};
			return { output: resolved, ...(costUsd !== undefined ? { costUsd } : {}) };
		},
	};
}
