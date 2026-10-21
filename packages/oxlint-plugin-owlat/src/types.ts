/**
 * The plugin API types, read off the `RuleTester` that oxlint itself ships in
 * `oxlint/plugins-dev`. oxlint exports no named rule types from its main entry,
 * and deriving them here keeps the plugin on the exact oxlint version the repo
 * lints with instead of a second, separately versioned types package.
 */
import type { RuleTester } from 'oxlint/plugins-dev';

export type Rule = Parameters<RuleTester['run']>[1];
type CreateRule = Extract<Rule, { create: (context: never) => unknown }>;
export type Context = Parameters<CreateRule['create']>[0];
type SourceCode = Context['sourceCode'];
export type Comment = ReturnType<SourceCode['getAllComments']>[number];
export type Scope = ReturnType<SourceCode['getScope']>;
/** Any ESTree node, as the scope API accepts it. */
export type AstNode = Parameters<SourceCode['getScope']>[0];
