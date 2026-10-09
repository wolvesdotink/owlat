import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The thread brief's backfill over a mailbox's recent mail (ADR-0072, D5):
 * one row per mailbox, driven by `mail/interpret/backfill.ts`.
 *
 * The walk pages the mailbox's threads newest first down to `cutoffAt` (30
 * days before the start) and hands each active one to interpretation, a few
 * messages at a time. `cursor` is the thread page to continue from, so a walk
 * stopped by the spend budget, the per-run cap or a cancel resumes where it
 * stopped. `paused` means it stopped on its own (`pausedReason`) and can be
 * resumed; `cancelled` was the owner's choice. Derived from the mailbox's
 * mail and naming no reader, so it goes with the mailbox.
 */
export const interpretBackfillTables = {
	interpretBackfillJobs: defineTable({
		mailboxId: v.id('mailboxes'),
		status: v.union(
			v.literal('running'),
			v.literal('paused'),
			v.literal('completed'),
			v.literal('cancelled')
		),
		pausedReason: v.optional(
			v.union(v.literal('budget'), v.literal('ai_off'), v.literal('run_cap'))
		),
		// Threads whose last message is at or after this are walked.
		cutoffAt: v.number(),
		cursor: v.optional(v.string()),
		scannedCount: v.number(),
		// Threads handed to interpretation, all runs of this walk; and in the current run.
		threadCount: v.number(),
		runThreadCount: v.number(),
		messageCount: v.number(),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
	}).index('by_mailbox', ['mailboxId']),
};
