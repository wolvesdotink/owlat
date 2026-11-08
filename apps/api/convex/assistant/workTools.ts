/**
 * The assistant's task and company tools: read-only views of the turn's own
 * user's work. Both answer only on a personal turn, the one with a mail
 * reader; a reply a whole room reads would show one member's tasks and
 * conversations to everyone in it, so there they return a note instead.
 *
 * Their reads live in `./workContext`, which applies the task page's and the
 * company page's own visibility helpers.
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { scrubToolOutput, type AssistantAudience } from './toolRegistry';
import { ASSISTANT_TASK_VIEWS } from './workContext';

/** What the model reads when the turn has no single user to answer for. */
const NO_PERSONAL_READER_NOTE =
	'Tasks and companies are not read in a conversation other people can read.';

export function buildListMyTasks(ctx: ActionCtx, audience: AssistantAudience): Tool {
	return tool({
		description:
			"List the user's tasks. By default their open tasks (assigned to them); or the open tasks everyone in the workspace sees, the open tasks of one of their groups, or recently finished ones. Each task has its title, who sees it, due date, company, assignee, creator and the conversation it came from.",
		inputSchema: z.object({
			view: z
				.enum(ASSISTANT_TASK_VIEWS)
				.optional()
				.describe(
					'mine (default): open tasks assigned to the user; everyone: open tasks the whole workspace sees; group: open tasks of the group named in groupName; done: recently finished tasks.'
				),
			groupName: z.string().optional().describe('The group, for the group view.'),
			limit: z.number().int().min(1).max(50).optional().describe('Max tasks (default 20).'),
		}),
		execute: async ({ view, groupName, limit }) => {
			// The reader comes from the turn, never from the model's input.
			const reader = audience.mailReader;
			if (!reader) return { tasks: [], note: NO_PERSONAL_READER_NOTE };
			const result = await ctx.runQuery(internal.assistant.workContext.myTasks, {
				userId: reader.userId,
				organizationId: reader.organizationId,
				view: view ?? 'mine',
				...(groupName ? { groupName } : {}),
				...(limit ? { limit } : {}),
			});
			// Titles and subjects are text anyone in the workspace, or a sender, wrote.
			return scrubToolOutput(result);
		},
	});
}

export function buildGetCompanyContext(ctx: ActionCtx, audience: AssistantAudience): Tool {
	return tool({
		description:
			'Look up a company the user works with, by name ("Northwind") or domain ("northwind.example"): its people, the user\'s recent conversations with it, the open tasks about it they can see, and which colleagues are also in touch with it.',
		inputSchema: z.object({
			company: z.string().describe('The company name, its domain, or an address there.'),
		}),
		execute: async ({ company }) => {
			const reader = audience.mailReader;
			if (!reader) return { found: false, note: NO_PERSONAL_READER_NOTE };
			const result = await ctx.runQuery(internal.assistant.workContext.companyContext, {
				userId: reader.userId,
				organizationId: reader.organizationId,
				company: company.slice(0, 200),
			});
			return scrubToolOutput(result);
		},
	});
}
