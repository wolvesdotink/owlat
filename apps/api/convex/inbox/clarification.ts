/**
 * Inbound clarification-loop mutation.
 *
 * Split out of `inbox/mutations.ts` to keep that file under the ~500 LOC
 * file-size ratchet (CONVENTIONS.md — split into domain siblings). Its
 * validators live in `lib/validators/clarification.ts`.
 */

import { v } from 'convex/values';
import { adminMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { clarificationFileRefValidator } from '../lib/validators/clarification';
import { captureStandingAnswers } from './clarificationMemory';
import { candidateForLabel, isFileQuestion } from './clarificationAnswers';
import {
	ownerPickSuggestion,
	resolveClarificationFile,
	type ClarificationFileRef,
} from './clarificationFileAnswer';

/**
 * Answer the open clarification questions parked on a message and resume the
 * draft.
 *
 * Backs the "Answer to continue" control on the review surface. The message was
 * parked in `awaiting_clarification` because the agent was missing a fact it
 * needed before it could safely draft; this folds the owner's answers back onto
 * `pendingClarification`, drives `awaiting_clarification → drafting` through the
 * single lifecycle writer, and schedules `walker.resumeDraft` to re-enter the
 * DRAFT step with the answers threaded in as a TRUSTED `[CONFIRMED BY OWNER]`
 * block. Mirrors `approveDraft`: authz is the `adminMutation` wrapper, the
 * status change is atomic inside the lifecycle, and the resume runs off the
 * scheduler so a slow draft never blocks the mutation.
 *
 * A `file` question is answered with a file reference (or, from older clients,
 * with the chip label of one of its `fileCandidates`). The file is checked, an
 * upload is saved to Files for the sender's contact unless `keepCopy` is false,
 * and a Files pick is recorded as the message's confident attachment
 * suggestion, which the resumed draft step keeps instead of searching again.
 */
export const answerClarification = adminMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		answers: v.array(
			v.object({
				questionId: v.string(),
				// Required unless `file` is given (then it defaults to the filename).
				value: v.optional(v.string()),
				// Origin of the value — the owner typed it ("user", default) or it
				// was auto-filled from stored memory ("memory").
				source: v.optional(v.union(v.literal('user'), v.literal('memory'))),
				file: v.optional(clarificationFileRefValidator),
				// Uploads only: false keeps the upload out of Files; the browser's
				// MIME type for the upload.
				keepCopy: v.optional(v.boolean()),
				mimeType: v.optional(v.string()),
			})
		),
	},
	handler: async (ctx, args, session) => {
		const message = await getOrThrow(ctx, args.inboundMessageId, 'Message');
		if (message.processingStatus !== 'awaiting_clarification') {
			throwInvalidState('Message is not awaiting clarification');
		}
		const pending = message.pendingClarification;
		if (!pending) throwInvalidState('No clarification is pending');

		const now = Date.now();
		const answerByQuestion = new Map(args.answers.map((a) => [a.questionId, a] as const));
		let pickedFile: Awaited<ReturnType<typeof resolveClarificationFile>>['semanticFile'];
		const questions = [];
		for (const q of pending.questions) {
			const provided = answerByQuestion.get(q.id);
			if (!provided) {
				questions.push(q);
				continue;
			}
			let fileRef: ClarificationFileRef | undefined = provided.file;
			if (!fileRef && isFileQuestion(q) && provided.value !== undefined) {
				const candidate = candidateForLabel(q.fileCandidates, provided.value);
				if (candidate) {
					fileRef = { source: candidate.source, id: candidate.id, filename: candidate.filename };
				}
			}
			if (fileRef && !isFileQuestion(q)) throwInvalidInput('This question does not take a file');
			const resolved = fileRef
				? await resolveClarificationFile(ctx, session, fileRef, {
						keepCopy: provided.keepCopy,
						mimeType: provided.mimeType,
						contactId: message.contactId,
						// Team replies attach from Files; mailbox attachments are Postbox-only.
						allowMailAttachment: false,
						canSaveToFiles: true,
					})
				: undefined;
			const value = provided.value ?? resolved?.ref.filename;
			if (value === undefined) throwInvalidInput('An answer needs a value or a file');
			if (resolved?.semanticFile && !pickedFile) pickedFile = resolved.semanticFile;
			questions.push({
				...q,
				answer: {
					value,
					source: provided.source ?? ('user' as const),
					at: now,
					...(resolved ? { file: resolved.ref } : {}),
				},
			});
		}

		// Persist the answers (advisory fields — direct patch, like editDraft). The
		// processingStatus change goes through the lifecycle below, not here. A
		// Files pick becomes the confident suggestion the review surface offers
		// and the resumed draft keeps.
		const pickStorageId = pickedFile?.storageId;
		await ctx.db.patch(args.inboundMessageId, {
			pendingClarification: { ...pending, questions, answeredAt: now },
			...(pickedFile && pickStorageId
				? {
						attachmentSuggestions: ownerPickSuggestion(
							{ ...pickedFile, storageId: pickStorageId },
							message.attachmentSuggestions?.query ?? ''
						),
					}
				: {}),
		});

		// ANSWER-MEMORY: promote the owner-typed answers to durable standing facts
		// scoped to this message's contact, so a later matching thread fills the
		// slot silently instead of re-asking. Only the owner's own answers (not
		// memory-replayed ones) are captured, and never a file answer: a filename
		// or "It isn't ready yet" is true for this request, not the next one.
		// Fail-soft: a memory-write failure never blocks resuming the draft.
		try {
			const capture = [] as { slotType: string; questionText: string; value: string }[];
			for (const q of questions) {
				const provided = answerByQuestion.get(q.id);
				if (!provided || !q.answer) continue;
				if ((provided.source ?? 'user') !== 'user') continue;
				if (isFileQuestion(q)) continue;
				capture.push({ slotType: q.slotType, questionText: q.text, value: q.answer.value });
			}
			if (capture.length > 0) {
				await captureStandingAnswers(ctx, {
					contactId: message.contactId,
					source: 'agent',
					answers: capture,
				});
			}
		} catch {
			// Memory is best-effort — never block the draft resume below.
		}

		// Drive awaiting_clarification → drafting via the single lifecycle writer.
		await ctx.runMutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: args.inboundMessageId,
			input: { to: 'drafting', at: now },
		});

		// Re-enter the DRAFT step with the confirmed answers folded in. Off the
		// scheduler so a slow draft can't block the mutation; the transition above
		// has already committed the message into `drafting`.
		await ctx.scheduler.runAfter(0, internal.agent.walker.resumeDraft, {
			inboundMessageId: args.inboundMessageId,
		});

		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'inbound.clarification_answered',
			resource: 'inbound_message',
			resourceId: args.inboundMessageId,
		});

		return { success: true };
	},
});
