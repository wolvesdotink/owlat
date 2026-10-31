/**
 * Setup shared by the tests that build temporary git repositories.
 */

/**
 * `git config` arguments that stop a temporary repository from starting
 * background maintenance. Apply them right after `git init` or `git clone`, in
 * every repository a test commits, merges, fetches or pushes into.
 *
 * Those commands finish by running `git maintenance run --auto`, which detaches
 * from the command that started it. Git's default geometric strategy then
 * repacks as soon as two loose objects share the sampled `objects/17/` shard,
 * so a repository of a dozen objects can still be writing packs into `.git`
 * after the command returned. The test's recursive removal then fails with
 * ENOTEMPTY, or leaves part of the repository behind.
 */
export const NO_AUTO_MAINTENANCE = ['config', 'maintenance.auto', 'false'] as const;
