/**
 * The JSON turbo prints that the repository scripts read: the task graph of a
 * `turbo run --dry=json`, and the workspace list of `turbo ls --output=json`.
 * The dry run is read two ways: the build-graph gate walks task dependencies,
 * and CI's selection reads each test task's package directory and command.
 */
import { arrayOf, decodeJson, object, optional, recordOf, string } from './json';

const decodeGraph = object({
	tasks: arrayOf(
		object({ taskId: string, package: string, task: string, dependencies: arrayOf(string) })
	),
});

type TurboGraph = ReturnType<typeof decodeGraph>;

/** A dry run's tasks with their dependency edges (`scripts/check-build-graph.ts`). */
export function parseTurboGraph(text: string, label: string): TurboGraph {
	return decodeJson(text, decodeGraph, label);
}

const decodeTaskList = object({
	tasks: arrayOf(
		object({ task: string, package: string, directory: string, command: optional(string) })
	),
});

/** A dry run's tasks with the package directory and command each one runs. */
export function parseTurboTasks(text: string, label: string) {
	return decodeJson(text, decodeTaskList, label).tasks;
}

const decodeWorkspaceList = object({
	packages: object({ items: arrayOf(object({ name: string, path: string })) }),
});

/** The workspaces `turbo ls --output=json` lists. */
export function parseTurboWorkspaces(
	text: string,
	label: string
): { name: string; path: string }[] {
	return decodeJson(text, decodeWorkspaceList, label).packages.items;
}

const decodeTurboConfig = object({
	tasks: recordOf(object({ inputs: optional(arrayOf(string)) })),
});

/** The task table of turbo.json, after its comments are stripped. */
export function decodeTurboTasks(value: unknown, label: string) {
	return decodeTurboConfig(value, label).tasks;
}
