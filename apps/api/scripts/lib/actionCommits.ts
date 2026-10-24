/**
 * How many separate commits a Convex action can make: the census behind
 * `check-action-commits.sh` ("Actions commit once" in `convex/CONVENTIONS.md`).
 *
 * Every `ctx.runMutation` an action makes is its own transaction. When an
 * action makes several on one run, a failure between them leaves the earlier
 * ones in place: a campaign in `sending` with no job, a row the next step was
 * meant to complete. The rule is to read, do the external I/O, then commit
 * once; this module counts how far each action is from that.
 *
 * The count for an action is the most `runMutation` calls ONE execution of its
 * handler can reach, read from the syntax tree (so a call in a comment or a
 * string is not one):
 *
 *   - statements in sequence add up; `if`/`else`, `? :` and `switch` take the
 *     costlier branch, and a branch that returns or throws does not add to
 *     the code after it;
 *   - `&&`, `||` and `??` add both sides, since the right side may run;
 *   - a `catch` adds to everything its `try` could have committed first, and
 *     `finally` adds to every path;
 *   - a loop body, or a callback handed to an array method (`map`, `forEach`,
 *     …), counts twice: it can commit once per item, and two is enough to make
 *     a single commit inside it an offender;
 *   - a call to a function declared in the same module (top level, or a named
 *     closure inside the handler) adds that function's own count, at each call;
 *     any other function literal counts once where it is written.
 *
 * Functions imported from another module are not followed, and neither is a
 * mutation reached through `ctx.runAction`. The count is a bound for review,
 * not a proof.
 *
 * A call is exempt when the statement making it is directly preceded by a
 * `// checkpoint: <reason>` line comment: the write is meant to stand on its
 * own if the action fails after it (a chunked job's per-page checkpoint, a
 * lease claimed before an external effect, a best-effort cache). A marker that
 * exempts no `runMutation` call, or gives no reason, is reported as a problem.
 */
import ts from 'typescript';

/** One action and the most commits one run of it can make. */
export interface ActionCommitCount {
	/** Module path as the census was given it (`convex/campaigns/send.ts`). */
	readonly module: string;
	/** The exported (or module-level) name the action is bound to. */
	readonly name: string;
	readonly commits: number;
}

export interface ModuleCensus {
	readonly actions: readonly ActionCommitCount[];
	/** `<module>:<line>: <what is wrong>`, for misplaced or empty markers. */
	readonly problems: readonly string[];
}

/** A loop body or per-item callback can commit at least this many times. */
const LOOP_FACTOR = 2;

/** Array methods whose callback runs once per element. */
const ITERATING_METHODS: ReadonlySet<string> = new Set([
	'map',
	'flatMap',
	'forEach',
	'filter',
	'reduce',
	'reduceRight',
	'some',
	'every',
	'find',
	'findIndex',
	'findLast',
	'findLastIndex',
]);

/** `action`, `internalAction`, `httpAction` and every composed `…Action` builder. */
const ACTION_BUILDER = /^(?:action|[A-Za-z0-9_$]*Action)$/;

const CHECKPOINT_MARKER = /^\/\/\s*checkpoint:(.*)$/;

const NONE = Number.NEGATIVE_INFINITY;

/**
 * The most commits on each way out of a piece of code: falling through to the
 * next statement, leaving the function (`return`/`throw`), or leaving the
 * enclosing loop or switch (`break`/`continue`). `NONE` when no path leaves
 * that way.
 */
interface Flow {
	readonly fall: number;
	readonly exit: number;
	readonly jump: number;
}

const straight = (commits: number): Flow => ({ fall: commits, exit: NONE, jump: NONE });

function sequence(first: Flow, then: Flow): Flow {
	return {
		fall: first.fall + then.fall,
		exit: Math.max(first.exit, first.fall + then.exit),
		jump: Math.max(first.jump, first.fall + then.jump),
	};
}

function either(left: Flow, right: Flow): Flow {
	return {
		fall: Math.max(left.fall, right.fall),
		exit: Math.max(left.exit, right.exit),
		jump: Math.max(left.jump, right.jump),
	};
}

const worst = (flow: Flow): number => Math.max(flow.fall, flow.exit, flow.jump, 0);

type FunctionLike = ts.FunctionLikeDeclaration;

function isFunctionLiteral(node: ts.Node): node is FunctionLike {
	return (
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function isStatementPosition(node: ts.Node): boolean {
	const parent = node.parent;
	return (
		ts.isBlock(parent) ||
		ts.isSourceFile(parent) ||
		ts.isCaseClause(parent) ||
		ts.isDefaultClause(parent) ||
		ts.isModuleBlock(parent) ||
		(ts.isIfStatement(parent) && parent.expression !== node) ||
		(ts.isIterationStatement(parent, false) && parent.statement === node) ||
		ts.isLabeledStatement(parent)
	);
}

function isRunMutationCall(node: ts.Node): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'runMutation'
	);
}

/** Named functions a body declares anywhere inside it, by binding name. */
function collectNamedFunctions(root: ts.Node, into: Map<string, FunctionLike>): void {
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionDeclaration(node) && node.name) {
			into.set(node.name.text, node);
		} else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
		) {
			into.set(node.name.text, node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(root, visit);
}

class ModuleAnalysis {
	private readonly text: string;
	private readonly topLevel = new Map<string, FunctionLike>();
	private readonly cost = new Map<FunctionLike, number>();
	private readonly inProgress = new Set<FunctionLike>();
	/** Every `// checkpoint:` comment, by its start offset. */
	readonly markers = new Map<number, Marker>();

	constructor(
		readonly module: string,
		readonly sourceFile: ts.SourceFile
	) {
		this.text = sourceFile.getFullText();
		for (const statement of sourceFile.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name) {
				this.topLevel.set(statement.name.text, statement);
			} else if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					const init = declaration.initializer;
					if (
						ts.isIdentifier(declaration.name) &&
						init &&
						(ts.isArrowFunction(init) || ts.isFunctionExpression(init))
					) {
						this.topLevel.set(declaration.name.text, init);
					}
				}
			}
		}
		this.collectMarkers();
		this.claimMarkers();
	}

	/** The handler of each module-level action, by binding name. */
	actions(): Array<{ name: string; handler: FunctionLike }> {
		const found: Array<{ name: string; handler: FunctionLike }> = [];
		for (const statement of this.sourceFile.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) continue;
				const handler = this.handlerOf(declaration.initializer);
				if (handler) found.push({ name: declaration.name.text, handler });
			}
		}
		return found;
	}

	private handlerOf(init: ts.Expression | undefined): FunctionLike | undefined {
		if (!init || !ts.isCallExpression(init)) return undefined;
		const callee = init.expression;
		if (!ts.isIdentifier(callee) || !ACTION_BUILDER.test(callee.text)) return undefined;
		const [definition] = init.arguments;
		if (!definition) return undefined;
		if (isFunctionLiteral(definition)) return definition;
		if (ts.isIdentifier(definition)) return this.topLevel.get(definition.text);
		if (!ts.isObjectLiteralExpression(definition)) return undefined;
		for (const property of definition.properties) {
			if (!property.name || !ts.isIdentifier(property.name)) continue;
			if (property.name.text !== 'handler') continue;
			if (ts.isMethodDeclaration(property)) return property;
			if (ts.isPropertyAssignment(property)) {
				const value = property.initializer;
				if (isFunctionLiteral(value)) return value;
				if (ts.isIdentifier(value)) return this.topLevel.get(value.text);
			}
			if (ts.isShorthandPropertyAssignment(property)) return this.topLevel.get('handler');
		}
		return undefined;
	}

	/** The most commits one call of `fn` can make. */
	functionCost(fn: FunctionLike): number {
		const known = this.cost.get(fn);
		if (known !== undefined) return known;
		if (this.inProgress.has(fn) || !fn.body) return 0;
		this.inProgress.add(fn);
		const locals = new Map<string, FunctionLike>();
		collectNamedFunctions(fn.body, locals);
		const commits = ts.isBlock(fn.body)
			? worst(this.block(fn.body.statements, locals))
			: this.expression(fn.body, locals);
		this.inProgress.delete(fn);
		this.cost.set(fn, commits);
		return commits;
	}

	private block(statements: ts.NodeArray<ts.Statement>, locals: Locals): Flow {
		let flow = straight(0);
		for (const statement of statements) flow = sequence(flow, this.statement(statement, locals));
		return flow;
	}

	private statement(node: ts.Statement, locals: Locals): Flow {
		if (ts.isBlock(node)) return this.block(node.statements, locals);
		if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
			const commits = node.expression ? this.expression(node.expression, locals) : 0;
			return { fall: NONE, exit: commits, jump: NONE };
		}
		if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
			return { fall: NONE, exit: NONE, jump: 0 };
		}
		if (ts.isIfStatement(node)) {
			const then = this.statement(node.thenStatement, locals);
			const otherwise = node.elseStatement
				? this.statement(node.elseStatement, locals)
				: straight(0);
			return sequence(straight(this.expression(node.expression, locals)), either(then, otherwise));
		}
		if (ts.isIterationStatement(node, false)) return this.loop(node, locals);
		if (ts.isSwitchStatement(node)) {
			let clauses: Flow | undefined;
			let hasDefault = false;
			for (const clause of node.caseBlock.clauses) {
				if (ts.isDefaultClause(clause)) hasDefault = true;
				const body = this.block(clause.statements, locals);
				// `break` leaves the switch, which is falling through past it.
				const flow = { fall: Math.max(body.fall, body.jump), exit: body.exit, jump: NONE };
				clauses = clauses ? either(clauses, flow) : flow;
			}
			const joined = clauses ?? straight(0);
			return sequence(
				straight(this.expression(node.expression, locals)),
				hasDefault ? joined : either(joined, straight(0))
			);
		}
		if (ts.isTryStatement(node)) {
			const attempt = this.block(node.tryBlock.statements, locals);
			let body = attempt;
			if (node.catchClause) {
				const recovered = this.block(node.catchClause.block.statements, locals);
				body = either(attempt, sequence(straight(worst(attempt)), recovered));
			}
			if (!node.finallyBlock) return body;
			const cleanup = this.block(node.finallyBlock.statements, locals);
			return {
				fall: body.fall + cleanup.fall,
				exit: Math.max(body.exit + cleanup.fall, worst(body) + cleanup.exit),
				jump: body.jump + cleanup.fall,
			};
		}
		if (ts.isLabeledStatement(node)) return this.statement(node.statement, locals);
		// Named functions are counted where they are called.
		if (ts.isFunctionDeclaration(node)) return straight(0);
		return straight(this.children(node, locals));
	}

	private loop(node: ts.IterationStatement, locals: Locals): Flow {
		let header = 0;
		if (ts.isForStatement(node)) {
			for (const part of [node.initializer, node.condition, node.incrementor]) {
				if (part) header += this.expression(part, locals);
			}
		} else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
			header += this.expression(node.expression, locals);
		} else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
			header += this.expression(node.expression, locals);
		}
		const body = this.statement(node.statement, locals);
		const perIteration = worst(body);
		const total = header + (perIteration > 0 ? LOOP_FACTOR * perIteration : 0);
		return { fall: total, exit: body.exit === NONE ? NONE : total, jump: NONE };
	}

	private expression(node: ts.Node, locals: Locals): number {
		if (isRunMutationCall(node)) {
			const own = this.isExempt(node) ? 0 : 1;
			return own + this.children(node, locals);
		}
		if (ts.isCallExpression(node)) return this.call(node, locals);
		if (ts.isConditionalExpression(node)) {
			return (
				this.expression(node.condition, locals) +
				Math.max(this.expression(node.whenTrue, locals), this.expression(node.whenFalse, locals))
			);
		}
		if (isFunctionLiteral(node)) {
			// A named closure is counted at each of its calls instead.
			const parent = node.parent;
			const isNamed =
				(ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) ||
				ts.isFunctionDeclaration(node);
			return isNamed ? 0 : this.functionCost(node);
		}
		return this.children(node, locals);
	}

	private call(node: ts.CallExpression, locals: Locals): number {
		const callee = node.expression;
		let commits = 0;
		if (ts.isIdentifier(callee)) {
			const target = locals.get(callee.text) ?? this.topLevel.get(callee.text);
			if (target) commits += this.functionCost(target);
		} else {
			commits += this.expression(callee, locals);
		}
		const iterates =
			ts.isPropertyAccessExpression(callee) && ITERATING_METHODS.has(callee.name.text);
		for (const argument of node.arguments) {
			const cost = this.expression(argument, locals);
			commits += iterates && isFunctionLiteral(argument) ? LOOP_FACTOR * cost : cost;
		}
		return commits;
	}

	private children(node: ts.Node, locals: Locals): number {
		let commits = 0;
		ts.forEachChild(node, (child) => {
			commits += ts.isBlock(child)
				? worst(this.block(child.statements, locals))
				: this.expression(child, locals);
		});
		return commits;
	}

	/** The statement a call is made in, for marker lookup. */
	private statementOf(node: ts.Node): ts.Node {
		let current = node;
		while (current.parent && !isStatementPosition(current)) current = current.parent;
		return current;
	}

	private isExempt(call: ts.CallExpression): boolean {
		return this.markersAbove(this.statementOf(call)).length > 0;
	}

	/** Own-line marker comments in the comment block directly above `statement`. */
	private markersAbove(statement: ts.Node): Marker[] {
		const ranges = ts.getLeadingCommentRanges(this.text, statement.getFullStart()) ?? [];
		return ranges
			.map((range) => this.markers.get(range.pos))
			.filter((marker): marker is Marker => marker !== undefined && marker.isOwnLine);
	}

	private collectMarkers(): void {
		const take = (ranges: readonly ts.CommentRange[] | undefined): void => {
			for (const range of ranges ?? []) {
				if (this.markers.has(range.pos)) continue;
				if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
				const match = CHECKPOINT_MARKER.exec(this.text.slice(range.pos, range.end));
				if (!match) continue;
				const { line, character } = this.sourceFile.getLineAndCharacterOfPosition(range.pos);
				const lineStart = this.sourceFile.getPositionOfLineAndCharacter(line, 0);
				this.markers.set(range.pos, {
					line: line + 1,
					reason: (match[1] ?? '').trim(),
					isOwnLine: this.text.slice(lineStart, lineStart + character).trim() === '',
					isClaimed: false,
				});
			}
		};
		const visit = (node: ts.Node): void => {
			take(ts.getLeadingCommentRanges(this.text, node.getFullStart()));
			take(ts.getTrailingCommentRanges(this.text, node.getEnd()));
			ts.forEachChild(node, visit);
		};
		visit(this.sourceFile);
	}

	/** Every runMutation call in the module claims the markers above its statement. */
	private claimMarkers(): void {
		const visit = (node: ts.Node): void => {
			if (isRunMutationCall(node)) {
				for (const marker of this.markersAbove(this.statementOf(node))) marker.isClaimed = true;
			}
			ts.forEachChild(node, visit);
		};
		visit(this.sourceFile);
	}
}

interface Marker {
	readonly line: number;
	readonly reason: string;
	/** Only a marker on a line of its own exempts the statement below it. */
	readonly isOwnLine: boolean;
	isClaimed: boolean;
}

type Locals = ReadonlyMap<string, FunctionLike>;

/** Count the commits of every action in one module's source. */
export function censusModule(module: string, source: string): ModuleCensus {
	const sourceFile = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
	const analysis = new ModuleAnalysis(module, sourceFile);
	const actions = analysis
		.actions()
		.map(({ name, handler }) => ({ module, name, commits: analysis.functionCost(handler) }));
	const problems: string[] = [];
	for (const marker of analysis.markers.values()) {
		if (!marker.isClaimed) {
			problems.push(
				`${module}:${marker.line}: a // checkpoint: marker must be a line of its own directly above the statement making the runMutation call it exempts`
			);
		} else if (marker.reason === '') {
			problems.push(
				`${module}:${marker.line}: a // checkpoint: marker needs a reason (why the write may stand alone)`
			);
		}
	}
	return { actions, problems };
}

/**
 * The census as ratchet entries: one line per commit past the first,
 * `<module>:<action> #<n>` for n = 2..commits. Fixing one commit removes the
 * highest line; adding one adds a line the baseline does not hold.
 */
export function censusLines(actions: readonly ActionCommitCount[]): string[] {
	const lines: string[] = [];
	for (const action of actions) {
		for (let n = 2; n <= action.commits; n += 1)
			lines.push(`${action.module}:${action.name} #${n}`);
	}
	return lines;
}
