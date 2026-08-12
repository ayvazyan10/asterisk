// AST for the RunCode mini-language.
//
// Every node carries a source position, because the only thing worse than a
// program failing at file 17 of 40 is a program failing at file 17 of 40 and
// not saying where. The interpreter attaches these to every runtime error.

export interface Pos {
  line: number;
  col: number;
}

export type Node = Expr | Stmt;

export type Expr =
  | ({ type: 'Num'; value: number } & Pos)
  | ({ type: 'Str'; value: string } & Pos)
  | ({ type: 'Tmpl'; quasis: string[]; exprs: Expr[] } & Pos)
  | ({ type: 'Bool'; value: boolean } & Pos)
  | ({ type: 'Null' } & Pos)
  | ({ type: 'Ident'; name: string } & Pos)
  | ({ type: 'Arr'; items: Expr[] } & Pos)
  | ({ type: 'Obj'; props: Array<{ key: string; value: Expr }> } & Pos)
  | ({ type: 'Unary'; op: string; arg: Expr } & Pos)
  | ({ type: 'Binary'; op: string; left: Expr; right: Expr } & Pos)
  | ({ type: 'Logical'; op: '&&' | '||' | '??'; left: Expr; right: Expr } & Pos)
  | ({ type: 'Cond'; test: Expr; then: Expr; other: Expr } & Pos)
  | ({ type: 'Assign'; op: string; target: Expr; value: Expr } & Pos)
  | ({ type: 'Update'; op: '++' | '--'; prefix: boolean; target: Expr } & Pos)
  | ({ type: 'Call'; callee: Expr; args: Expr[]; optional: boolean } & Pos)
  | ({ type: 'Member'; object: Expr; property: Expr; computed: boolean; optional: boolean } & Pos)
  | ({ type: 'Arrow'; params: string[]; body: Expr | Stmt } & Pos);

export type Stmt =
  | ({ type: 'Program'; body: Stmt[] } & Pos)
  | ({ type: 'Block'; body: Stmt[] } & Pos)
  | ({ type: 'VarDecl'; kind: 'const' | 'let'; name: string; init: Expr | null } & Pos)
  | ({ type: 'ExprStmt'; expr: Expr } & Pos)
  | ({ type: 'If'; test: Expr; then: Stmt; other: Stmt | null } & Pos)
  | ({ type: 'While'; test: Expr; body: Stmt } & Pos)
  | ({ type: 'ForOf'; name: string; iterable: Expr; body: Stmt } & Pos)
  | ({ type: 'For'; init: Stmt | null; test: Expr | null; update: Expr | null; body: Stmt } & Pos)
  | ({ type: 'Return'; value: Expr | null } & Pos)
  | ({ type: 'Break' } & Pos)
  | ({ type: 'Continue' } & Pos);

/** Reserved words the language refuses outright, with the reason it gives. */
export const REFUSED_KEYWORDS: Readonly<Record<string, string>> = {
  function: 'function declarations are not supported — use an arrow function: const f = (x) => …',
  class: 'classes are not supported',
  new: '`new` is not supported — there are no constructors in this language',
  this: '`this` is not supported',
  import: 'modules are not reachable from a program; call tools instead',
  export: '`export` is not supported',
  require: 'modules are not reachable from a program; call tools instead',
  eval: '`eval` is not supported',
  var: 'use `const` or `let` instead of `var`',
  try: 'there is no `try`/`catch` — tool() returns { ok, output } instead of throwing',
  catch: 'there is no `try`/`catch` — tool() returns { ok, output } instead of throwing',
  throw: '`throw` is not supported',
  switch: '`switch` is not supported — use if/else',
  do: '`do…while` is not supported — use `while`',
  yield: '`yield` is not supported',
  async: 'everything is already awaited for you — drop `async`',
  delete: '`delete` is not supported',
  in: '`in` is not supported — use Object.keys(o).includes(k)',
  instanceof: '`instanceof` is not supported',
  void: '`void` is not supported',
  with: '`with` is not supported',
};
