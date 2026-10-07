/**
 * The `clarify` step's link from a question to the thread item it fills
 * (SPEC §6): the thread's open items are listed in the slot prompt, and a
 * question whose slot names one carries its `itemId`. The plan then holds
 * that item at `clarify` until the question is answered.
 *
 * FAIL-SOFT: no items, questions without a link (today's behaviour).
 */

import { internal } from '../../../_generated/api';
import type { ActionCtx } from '../../../_generated/server';
import type { Id } from '../../../_generated/dataModel';
import {
	itemIdForSlot,
	slotItemsOf,
	type ReplySlot,
	type SlotItem,
} from '../../../inbox/clarificationSlots';

export type ClarifySlotItem = SlotItem<Id<'threadItems'>>;

/** The open items of the message's thread, named for the slot prompt. */
export async function loadSlotItems(
	ctx: Pick<ActionCtx, 'runQuery'>,
	inboundMessageId: Id<'inboundMessages'>
): Promise<ClarifySlotItem[]> {
	try {
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId,
		});
		if (!message?.threadId) return [];
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: { kind: 'team', id: message.threadId },
			draftRef: { kind: 'inboundDraft', id: inboundMessageId },
		});
		return slotItemsOf(loaded.items);
	} catch {
		return [];
	}
}

/** `{itemId}` for a slot that fills a listed item, else nothing to spread. */
export function slotItemLink(
	slot: Pick<ReplySlot, 'itemRef'>,
	items: readonly ClarifySlotItem[]
): { itemId: Id<'threadItems'> } | Record<string, never> {
	const itemId = itemIdForSlot(slot, items);
	return itemId ? { itemId } : {};
}
