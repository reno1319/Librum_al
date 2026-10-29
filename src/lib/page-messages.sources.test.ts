// B16 guard: reads every source file that sends `?error=` / `?success=`
// and checks that each message it can send is on the page-messages.ts
// allowlist, and that every page passes these values through a filter.
// Both checks fail closed: a shape they cannot read fails the test. Without
// them the list could silently fall behind the code, and a real message
// would turn into the generic one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { AUTH_GENERIC_ERROR_MESSAGE } from "@/lib/auth-page-messages";
import { HOME_SLOTS } from "@/lib/home-picks-logic";
import { PAGE_ERROR_MESSAGES, PAGE_SUCCESS_MESSAGES } from "@/lib/page-messages";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

// Pages that already have their own allowlist (SQ-16, auth-page-messages.ts).
const SIGN_IN_PAGES = ["/login", "/signup", "/forgot-password", "/reset-password"];
// The admin actions' own helper: withQuery(path, "error" | "success", message).
const QUERY_HELPER = "withQuery";

type Kind = "error" | "success";

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const parsed = new Map<string, ts.SourceFile>();
function sourceFile(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, sf);
  }
  return sf;
}

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

class Unresolved extends Error {}

// Values the reader cannot see in the code, taken from the constant
// that bounds them. Key: file and expression text.
const KNOWN_VALUES: Record<string, () => string[]> = {
  // Home-page slot numbers in "That book is already in slot N."
  "src/app/admin/(protected)/librum-choice/actions.ts result.slot": () => HOME_SLOTS.map(String),
  // mapBlogRpcError() passes the blog functions' own field messages
  // through (same pattern as blog-form-logic.ts), read from schema.sql.
  "src/app/admin/(protected)/blog/blog-form-logic.ts error.message": () => [
    ...new Set(
      [...readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8").matchAll(/raise exception '([^']*)'/g)]
        .map((m) => m[1])
        .filter((m) => /^(title|slug|excerpt|content_markdown|seo_title|seo_description) (must|is)/.test(m)),
    ),
  ],
};

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

// Every value `node` can have, as plain strings. Throws Unresolved for
// anything that is not built only from our own literals and constants.
function values(node: ts.Expression, sf: ts.SourceFile, depth = 0): string[] {
  if (depth > 40) throw new Unresolved(node.getText(sf));
  const next = (n: ts.Expression, f: ts.SourceFile = sf) => values(n, f, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isNumericLiteral(node)) return [String(Number(node.text))];
  // `x ?? FALLBACK`: a null side sends nothing.
  if (node.kind === ts.SyntaxKind.NullKeyword) return [];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return next(node.expression);
  }
  if (ts.isConditionalExpression(node)) return [...next(node.whenTrue), ...next(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return combine([next(node.left), next(node.right)]);
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return [...next(node.left), ...next(node.right)];
    }
    // `x && MAP[x]`: a falsy x shows nothing, otherwise the right side.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return next(node.right);
  }
  if (ts.isTemplateExpression(node)) {
    const parts: string[][] = [[node.head.text]];
    for (const span of node.templateSpans) parts.push(next(span.expression), [span.literal.text]);
    return combine(parts);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (callee.text === "encodeURIComponent" && node.arguments.length === 1) {
        return next(node.arguments[0]).map(encodeURIComponent);
      }
      if (callee.text === "String" && node.arguments.length === 1) return next(node.arguments[0]);
      const fn = findFunction(callee.text, sf);
      if (fn) return withArguments(fn.decl, node.arguments, sf, () => returnValues(fn.decl, fn.sf, depth + 1));
    }
    // `NUMBER.toLocaleString()`, formatted the same way here.
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toLocaleString" && node.arguments.length === 0) {
      return next(callee.expression).map((v) => Number(v).toLocaleString());
    }
    // `.replace(/regex/flags, "literal")` on a value we know.
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "replace" &&
      node.arguments.length === 2 &&
      ts.isRegularExpressionLiteral(node.arguments[0])
    ) {
      const literal = node.arguments[0].text;
      const slash = literal.lastIndexOf("/");
      const re = new RegExp(literal.slice(1, slash), literal.slice(slash + 1));
      const replacements = next(node.arguments[1]);
      return next(callee.expression).flatMap((v) => replacements.map((r) => v.replace(re, r)));
    }
  }
  const known = KNOWN_VALUES[`${path.relative(ROOT, sf.fileName)} ${node.getText(sf)}`];
  if (known) return known();
  if (ts.isPropertyAccessExpression(node)) return propertyValues(node.expression, node.name.text, sf, depth + 1);
  // `MAP[key]`: every value of an object of our own strings.
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const local = localDeclaration(node.expression);
    if (local) requireConst(local, sf);
    const obj = local?.initializer ? { init: local.initializer, sf } : topLevelInitializer(node.expression.text, sf);
    if (obj && ts.isObjectLiteralExpression(obj.init)) {
      refuseMemberWrites(node.expression.text, obj.sf);
      return obj.init.properties.flatMap((p) => {
        if (!ts.isPropertyAssignment(p)) throw new Unresolved(p.getText(obj.sf));
        return values(p.initializer, obj.sf, depth + 1);
      });
    }
  }
  if (ts.isIdentifier(node)) {
    const local = localValues(node, sf, depth + 1);
    if (local) return local;
    const top = topLevelInitializer(node.text, sf);
    if (top) return values(top.init, top.sf, depth + 1);
  }
  throw new Unresolved(node.getText(sf));
}

// Only `const` declarations are followed: a `let` could be changed
// anywhere.
function requireConst(decl: ts.VariableDeclaration, sf: ts.SourceFile) {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) {
    throw new Unresolved(`not a const: ${decl.getText(sf)}`);
  }
}

// `OBJ.x = ...` / `OBJ[k] = ...` anywhere in the file.
function refuseMemberWrites(name: string, sf: ts.SourceFile) {
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left)) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === name
    ) {
      throw new Unresolved(`${name} is changed: ${n.getText(sf)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// Every element of a const array literal, for `for (const k of LIST)`.
function arrayValues(node: ts.Expression, sf: ts.SourceFile, depth: number): string[] {
  let expr: ts.Expression = node;
  while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.flatMap((e) => {
      if (ts.isSpreadElement(e)) throw new Unresolved(e.getText(sf));
      return values(e, sf, depth);
    });
  }
  if (ts.isIdentifier(expr)) {
    const local = localDeclaration(expr);
    if (local) requireConst(local, sf);
    const found = local?.initializer ? { init: local.initializer, sf } : topLevelInitializer(expr.text, sf);
    if (found) {
      refuseMemberWrites(expr.text, found.sf);
      return arrayValues(found.init, found.sf, depth);
    }
  }
  throw new Unresolved(`not a fixed list: ${node.getText(sf)}`);
}

function combine(parts: string[][]): string[] {
  return parts.reduce<string[]>((acc, part) => acc.flatMap((a) => part.map((p) => a + p)), [""]);
}

function enclosingFunction(node: ts.Node): Fn | null {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return n;
  }
  return null;
}

// The value of `obj.prop`, where obj is a local or a call whose
// function returns object literals.
function propertyValues(obj: ts.Expression, prop: string, sf: ts.SourceFile, depth: number): string[] {
  if (depth > 40) throw new Unresolved(obj.getText(sf));
  if (ts.isParenthesizedExpression(obj) || ts.isAwaitExpression(obj)) {
    return propertyValues(obj.expression, prop, sf, depth + 1);
  }
  if (ts.isObjectLiteralExpression(obj)) {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) throw new Unresolved(p.getText(sf));
      if ((ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isMethodDeclaration(p)) && p.name.getText(sf) === prop) {
        throw new Unresolved(p.getText(sf));
      }
      if (ts.isPropertyAssignment(p) && p.name.getText(sf) === prop) return values(p.initializer, sf, depth + 1);
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop) return values(p.name, sf, depth + 1);
    }
    return [];
  }
  if (ts.isCallExpression(obj) && ts.isIdentifier(obj.expression)) {
    const fn = findFunction(obj.expression.text, sf);
    if (fn) {
      return withArguments(fn.decl, obj.arguments, sf, () =>
        returnExpressions(fn.decl).flatMap((r) => propertyValues(r, prop, fn.sf, depth + 1)),
      );
    }
  }
  if (ts.isIdentifier(obj)) {
    const decl = localDeclaration(obj);
    if (decl?.initializer && ts.isIdentifier(decl.name)) {
      requireConst(decl, sf);
      refuseMemberWrites(obj.text, sf);
      return propertyValues(decl.initializer, prop, sf, depth + 1);
    }
  }
  throw new Unresolved(`${obj.getText(sf)}.${prop}`);
}

function localDeclaration(id: ts.Identifier): ts.VariableDeclaration | null {
  for (let fn = enclosingFunction(id); fn; fn = enclosingFunction(fn)) {
    let found: ts.VariableDeclaration | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text) found = n;
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    if (found) return found;
  }
  return null;
}

// A local declared inside an enclosing function (plain, destructured,
// or a parameter), with every later assignment to it.
function localValues(id: ts.Identifier, sf: ts.SourceFile, depth: number): string[] | null {
  for (let fn = enclosingFunction(id); fn; fn = enclosingFunction(fn)) {
    const index = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
    if (index >= 0) {
      const bound = boundArguments.get(fn.parameters[index]);
      if (bound) {
        if (bound.arg) return values(bound.arg, bound.sf, depth);
        const fallback = fn.parameters[index].initializer;
        return fallback ? values(fallback, sf, depth) : [];
      }
      return argumentValues(fn, index, sf, depth);
    }
    const found: string[] = [];
    let declared = false;
    const named = (n: ts.Node) => ts.isIdentifier(n) && n.text === id.text;
    const mentions = (n: ts.Node): boolean => named(n) || ts.forEachChild(n, mentions) === true;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n)) {
        if (named(n.name)) {
          declared = true;
          const holder = n.parent.parent;
          if (ts.isCatchClause(n.parent) || ts.isForInStatement(holder)) {
            throw new Unresolved(`${id.text} is not built from our text`);
          } else if (ts.isForOfStatement(holder)) {
            found.push(...arrayValues(holder.expression, sf, depth));
          } else if (n.initializer) {
            found.push(...values(n.initializer, sf, depth));
          }
        } else if (ts.isObjectBindingPattern(n.name) && n.initializer) {
          for (const el of n.name.elements) {
            if (!mentions(el.name)) continue;
            if (!ts.isIdentifier(el.name) || el.dotDotDotToken) throw new Unresolved(el.getText(sf));
            declared = true;
            const prop = (el.propertyName ?? el.name).getText(sf);
            found.push(...propertyValues(n.initializer, prop, sf, depth));
          }
        } else if (mentions(n.name)) {
          throw new Unresolved(`${id.text} comes from ${n.getText(sf)}`);
        }
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && named(n.left)) {
        found.push(...values(n.right, sf, depth));
      } else if (
        (ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          mentions(n.left)) ||
        ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && named(n.operand))
      ) {
        // `m += x`, `[m] = x`, `({ m } = x)`, `m++`
        throw new Unresolved(`${id.text} is changed: ${n.getText(sf)}`);
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    if (declared) return found;
  }
  return null;
}

// While a call is being followed into its function, each parameter
// stands for the argument of that call.
const boundArguments = new Map<ts.ParameterDeclaration, { arg: ts.Expression | undefined; sf: ts.SourceFile }>();
function withArguments<T>(fn: Fn, args: ts.NodeArray<ts.Expression>, sf: ts.SourceFile, run: () => T): T {
  const saved = fn.parameters.map((p) => boundArguments.get(p));
  fn.parameters.forEach((p, i) => boundArguments.set(p, { arg: args[i], sf }));
  try {
    return run();
  } finally {
    fn.parameters.forEach((p, i) => {
      const old = saved[i];
      if (old) boundArguments.set(p, old);
      else boundArguments.delete(p);
    });
  }
}

function functionName(fn: Fn): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return null;
}

// A parameter: every argument the same file passes in that position.
function argumentValues(fn: Fn, index: number, sf: ts.SourceFile, depth: number): string[] {
  const name = functionName(fn);
  if (!name) throw new Unresolved(`parameter ${index} of an unnamed function`);
  const declaration = ts.isFunctionDeclaration(fn) ? fn : fn.parent.parent.parent;
  if (ts.canHaveModifiers(declaration) && ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    throw new Unresolved(`${name}(): exported, so other files may call it`);
  }
  const found: string[] = [];
  let calls = 0;
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name && n !== (fn as ts.FunctionDeclaration).name && !ts.isVariableDeclaration(n.parent)) {
      // Every use must be a direct call, or the function could be
      // handed elsewhere and called with something we never see.
      if (!ts.isCallExpression(n.parent) || n.parent.expression !== n) {
        throw new Unresolved(`${name}(): used as a value`);
      }
      calls += 1;
      const arg = n.parent.arguments[index];
      if (arg) found.push(...values(arg, sf, depth));
      else {
        const fallback = fn.parameters[index].initializer;
        if (fallback) found.push(...values(fallback, sf, depth));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (calls === 0) throw new Unresolved(`${name}(): no calls in this file`);
  return found;
}

function importTarget(name: string, sf: ts.SourceFile): { name: string; sf: ts.SourceFile } | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text !== name) continue;
      const target = resolveImport(sf.fileName, (stmt.moduleSpecifier as ts.StringLiteral).text);
      return target ? { name: (el.propertyName ?? el.name).text, sf: sourceFile(target) } : null;
    }
  }
  return null;
}

function topLevelInitializer(name: string, sf: ts.SourceFile): { init: ts.Expression; sf: ts.SourceFile } | null {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
        requireConst(d, sf);
        return { init: d.initializer, sf };
      }
    }
  }
  const imported = importTarget(name, sf);
  return imported ? topLevelInitializer(imported.name, imported.sf) : null;
}

function findFunction(name: string, sf: ts.SourceFile): { decl: Fn; sf: ts.SourceFile } | null {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) return { decl: stmt, sf };
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          return { decl: d.initializer, sf };
        }
      }
    }
  }
  const imported = importTarget(name, sf);
  return imported ? findFunction(imported.name, imported.sf) : null;
}

function returnExpressions(fn: Fn): ts.Expression[] {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (n: ts.Node) => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) found.push(n.expression);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function returnValues(fn: Fn, sf: ts.SourceFile, depth: number): string[] {
  return returnExpressions(fn).flatMap((r) => values(r, sf, depth));
}

const unresolvedReason = new Map<string, string>();

type Site = { file: string; line: number; kind: Kind; text: string; messages: string[] | null };

const KEY = /(?:^|[?&])(error|success)=/g;

// The exact text the admin helper must have; its calls are read instead
// of its body.
const QUERY_HELPER_BODY = '{\n  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;\n}';

// Whether a template part after a message only starts the next query
// parameter (`${next ? `&next=...` : ""}`), read from its literals.
function startsNextParam(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return startsNextParam(node.expression);
  if (ts.isConditionalExpression(node)) return startsNextParam(node.whenTrue) && startsNextParam(node.whenFalse);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === "" || /^[&#]/.test(node.text);
  if (ts.isTemplateExpression(node)) return /^[&#]/.test(node.head.text);
  return false;
}

// Every place one file can send `?error=` / `?success=`. Fails closed:
// any shape it does not know (strings joined with +, a message made of
// two parts, a query key built at run time, URLSearchParams) becomes a
// site with no messages, which fails the test below.
function sitesIn(sf: ts.SourceFile, rel: string): Site[] {
  const sites: Site[] = [];
  const signInTarget = (text: string) => SIGN_IN_PAGES.some((p) => text.startsWith(`${p}?`));
  const visit = (n: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const add = (kind: Kind, text: string, read: () => string[]) => {
      let messages: string[] | null;
      try {
        messages = read();
      } catch (e) {
        if (!(e instanceof Unresolved)) throw e;
        messages = null;
        unresolvedReason.set(`${rel}:${line}`, e.message);
      }
      sites.push({ file: rel, line, kind, text, messages });
    };
    const refuse = (text: string, why: string) =>
      add("error", text, () => {
        throw new Unresolved(why);
      });

    if (ts.isFunctionDeclaration(n) && n.name?.text === QUERY_HELPER && n.body?.getText(sf) !== QUERY_HELPER_BODY) {
      refuse(QUERY_HELPER, `${QUERY_HELPER}() body differs from the one this test knows`);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === QUERY_HELPER) {
      if (n.arguments.length !== 3) refuse(n.getText(sf), `${QUERY_HELPER}() needs exactly 3 arguments`);
      else {
        const [, keyArg, messageArg] = n.arguments;
        // `ok ? "success" : "error"` with `ok ? A : B` splits into two sites.
        const pairs: [ts.Expression, ts.Expression][] =
          ts.isConditionalExpression(keyArg) &&
          ts.isConditionalExpression(messageArg) &&
          keyArg.condition.getText(sf) === messageArg.condition.getText(sf)
            ? [
                [keyArg.whenTrue, messageArg.whenTrue],
                [keyArg.whenFalse, messageArg.whenFalse],
              ]
            : [[keyArg, messageArg]];
        for (const [key, message] of pairs) {
          const kind = ts.isStringLiteral(key) ? key.text : null;
          if (kind !== "error" && kind !== "success") refuse(key.getText(sf), `${QUERY_HELPER} key ${key.getText(sf)}`);
          else add(kind, message.getText(sf), () => values(message, sf));
        }
      }
    }

    // URLSearchParams / searchParams.set() never carry these keys.
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URLSearchParams") {
      const arg = n.arguments?.[0];
      if (arg) {
        const ok =
          ts.isObjectLiteralExpression(arg) &&
          arg.properties.every(
            (p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              !["error", "success"].includes(p.name.getText(sf).replace(/["']/g, "")),
          );
        if (!ok) refuse(n.getText(sf), "URLSearchParams built with error/success or from an unknown object");
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["set", "append"].includes(n.expression.name.text) &&
      n.arguments.length === 2
    ) {
      const target = n.expression.expression;
      const decl = ts.isIdentifier(target) ? localDeclaration(target) : null;
      const isQuery =
        (ts.isPropertyAccessExpression(target) && target.name.text === "searchParams") ||
        (!!decl?.initializer &&
          ts.isNewExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression) &&
          decl.initializer.expression.text === "URLSearchParams");
      if (isQuery) {
        add("error", n.getText(sf), () => {
          const keys = values(n.arguments[0], sf);
          if (keys.some((k) => k === "error" || k === "success")) throw new Unresolved("query key error/success set at run time");
          return [];
        });
      }
    }

    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const matches = [...n.text.matchAll(KEY)];
      if (matches.length && !signInTarget(n.text)) {
        if (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          refuse(n.text, "query joined with +; write it as one template literal");
        } else {
          for (const m of matches) {
            const value = /^[^&#]*/.exec(n.text.slice(m.index! + m[0].length))![0];
            add(m[1] as Kind, value, () => [decodeURIComponent(value)]);
          }
        }
      }
    }

    if (ts.isTemplateExpression(n) && !signInTarget(n.head.text)) {
      const chunks = [n.head.text, ...n.templateSpans.map((span) => span.literal.text)];
      if (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken && chunks.some((c) => KEY.test(c))) {
        KEY.lastIndex = 0;
        refuse(n.getText(sf), "query joined with +; write it as one template literal");
      }
      KEY.lastIndex = 0;
      chunks.forEach((chunk, i) => {
        // `?${key}=`: a run-time query key, only inside the helper.
        if (i > 0 && chunk.startsWith("=")) {
          const fn = enclosingFunction(n);
          if (!fn || functionName(fn) !== QUERY_HELPER) refuse(n.templateSpans[i - 1].expression.getText(sf), "query key built at run time");
        }
        for (const m of chunk.matchAll(KEY)) {
          const rest = chunk.slice(m.index! + m[0].length);
          const inline = /^[^&#]*/.exec(rest)![0];
          const isLast = i === chunks.length - 1;
          if (inline.length < rest.length || isLast) {
            add(m[1] as Kind, inline, () => [decodeURIComponent(inline)]);
            continue;
          }
          // The value runs into `${...}`: it must be exactly that one
          // part, followed by the end, `&`/`#`, or a part that only
          // starts the next parameter.
          const span = n.templateSpans[i];
          const after = span.literal.text;
          const nextSpan = n.templateSpans[i + 1];
          const clean =
            inline === "" &&
            (/^[&#]/.test(after) || (after === "" && (i + 1 === n.templateSpans.length || (nextSpan && startsNextParam(nextSpan.expression)))));
          if (!clean) refuse(span.expression.getText(sf), "a message must be one value: one constant, call or variable");
          else add(m[1] as Kind, span.expression.getText(sf), () => values(span.expression, sf).map((v) => decodeURIComponent(v)));
        }
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function collectSites(): Site[] {
  return listSourceFiles(SRC).flatMap((file) => sitesIn(sourceFile(file), path.relative(ROOT, file)));
}

// Flags, not text: the page prints its own fixed line for them.
const NOT_PRINTED: ReadonlySet<string> = new Set(["src/app/(public)/dashboard/profile/actions.ts success=1"]);

describe("page-messages allowlist matches every message the code sends", () => {
  const sites = collectSites().filter((s) => !NOT_PRINTED.has(`${s.file} ${s.kind}=${s.text}`));

  it("finds the redirect sites", () => {
    expect(sites.length).toBeGreaterThan(250);
  });

  it.each(sites.map((s) => [`${s.file}:${s.line} ${s.kind}=${s.text}`, s] as const))("%s", (_label, site) => {
    expect(
      site.messages,
      `cannot tell what this sends (${unresolvedReason.get(`${site.file}:${site.line}`)}); build the message only from literals or constants`,
    ).not.toBeNull();
    const allowed = site.kind === "error" ? PAGE_ERROR_MESSAGES : PAGE_SUCCESS_MESSAGES;
    // An empty value shows nothing, so it needs no list entry.
    for (const message of site.messages!.filter((m) => m !== "")) {
      expect(allowed.has(message), `missing from page-messages.ts (${site.kind}): ${message}`).toBe(true);
    }
  });

  it("lists no message the code no longer sends", () => {
    const sent = { error: new Set<string>(), success: new Set<string>() };
    for (const site of sites) for (const m of site.messages ?? []) sent[site.kind].add(m);
    sent.error.add(AUTH_GENERIC_ERROR_MESSAGE);
    expect([...PAGE_ERROR_MESSAGES].filter((m) => !sent.error.has(m))).toEqual([]);
    expect([...PAGE_SUCCESS_MESSAGES].filter((m) => !sent.success.has(m))).toEqual([]);
  });
});

describe("the source reader refuses what it cannot follow", () => {
  const read = (code: string) => {
    const sf = ts.createSourceFile("/virtual.ts", code, ts.ScriptTarget.Latest, true);
    let found: ts.TemplateExpression | null = null;
    const visit = (n: ts.Node) => {
      if (!found && ts.isTemplateExpression(n)) found = n;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return values((found as unknown as ts.TemplateExpression).templateSpans[0].expression, sf);
  };

  it("follows constants, branches and fallbacks", () => {
    expect(
      read('const A = "Një"; function f(x: boolean) { const m = x ? A : null; redirect(`/p?error=${encodeURIComponent(m ?? "Dy")}`); }'),
    ).toEqual([encodeURIComponent("Një"), encodeURIComponent("Dy")]);
  });

  it("refuses form input", () => {
    expect(() =>
      read('async function act(formData: FormData) { const m = String(formData.get("x")); redirect(`/p?error=${encodeURIComponent(m)}`); }'),
    ).toThrow(Unresolved);
  });

  it("refuses an exported helper's parameter", () => {
    expect(() => read("export function fail(m: string) { redirect(`/p?error=${encodeURIComponent(m)}`); }")).toThrow(
      Unresolved,
    );
  });

  it("refuses a helper handed on as a value", () => {
    expect(() =>
      read('function fail(m: string) { redirect(`/p?error=${encodeURIComponent(m)}`); } fail("A"); [1].forEach(fail);'),
    ).toThrow(Unresolved);
  });
});

// Calls that turn a raw `?error=` / `?success=` into text that is safe
// to show (SQ-16's for the sign-in pages, B16's for the rest).
const FILTERS = new Set(["pageErrorMessage", "pageSuccessMessage", "translateAuthErrorMessage", "authSuccessMessage"]);

// The request URLs route handlers read their own query from.
const REQUEST_URLS: ReadonlySet<string> = new Set(["request.nextUrl", "new URL(request.url)"]);

// The member names of a `searchParams: Promise<{...}>` type, following a
// type alias in the same file or an import. Throws when it cannot tell.
function queryKeys(type: ts.TypeNode | undefined, sf: ts.SourceFile): Set<string> {
  if (!type) throw new Unresolved("searchParams has no type");
  if (ts.isTypeReferenceNode(type) && type.typeName.getText(sf) === "Promise" && type.typeArguments?.length === 1) {
    return queryKeys(type.typeArguments[0], sf);
  }
  if (ts.isParenthesizedTypeNode(type)) return queryKeys(type.type, sf);
  if (ts.isTypeLiteralNode(type)) {
    const keys = new Set<string>();
    for (const m of type.members) {
      if (!ts.isPropertySignature(m) || !m.name) throw new Unresolved(`searchParams type member ${m.getText(sf)}`);
      keys.add(m.name.getText(sf).replace(/["']/g, ""));
    }
    return keys;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    for (const stmt of sf.statements) {
      if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return queryKeys(stmt.type, sf);
    }
    const imported = importTarget(name, sf);
    if (imported) return queryKeys(ts.factory.createTypeReferenceNode(imported.name), imported.sf);
  }
  throw new Unresolved(`searchParams type ${type.getText(sf)}`);
}

// Every way a file can read `?error=` / `?success=` from searchParams and
// print it. Fails closed: the only accepted shape is
// `const { error: rawError } = await searchParams` with each raw value
// used only inside a FILTERS call or as a yes/no test.
function pageProblems(sf: ts.SourceFile): string[] {
  const problems: string[] = [];
  const say = (n: ts.Node, why: string) =>
    problems.push(`line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${why}`);
  const keysByFunction = new Map<ts.Node, Set<string>>();

  // Where a raw value may appear: as a filter argument or a yes/no test.
  const safeUse = (ref: ts.Identifier): boolean => {
    let n: ts.Node = ref;
    while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
    const parent = n.parent;
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.arguments.includes(n as ts.Expression)) {
      return FILTERS.has(parent.expression.text) || parent.expression.text === "Boolean";
    }
    if (ts.isBinaryExpression(parent) && parent.left === n && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === n) return true;
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isIfStatement(parent) && parent.expression === n) return true;
    return false;
  };

  const checkBinding = (decl: ts.VariableDeclaration, fn: ts.Node) => {
    const pattern = decl.name as ts.ObjectBindingPattern;
    for (const el of pattern.elements) {
      if (el.dotDotDotToken) {
        say(el, "`...rest` from searchParams could carry error/success");
        continue;
      }
      const key = (el.propertyName ?? el.name).getText(sf);
      if (key !== "error" && key !== "success") continue;
      if (!ts.isIdentifier(el.name)) {
        say(el, `?${key}= read into a pattern`);
        continue;
      }
      const local = el.name.text;
      const visit = (n: ts.Node) => {
        const isName =
          ts.isPropertySignature(n.parent) ||
          ts.isBindingElement(n.parent) ||
          (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) ||
          (ts.isPropertyAssignment(n.parent) && n.parent.name === n);
        if (ts.isIdentifier(n) && n.text === local && n !== el.name && !isName) {
          if (!safeUse(n)) {
            say(n, `raw ?${key}= (${local}) used outside ${[...FILTERS].join("/")}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
    }
  };

  const visit = (n: ts.Node) => {
    // Outside the page parameter, the address may be read only by route
    // handlers, from their own request (which never render a page).
    if (ts.isIdentifier(n) && n.text === "useSearchParams") say(n, "useSearchParams() reads the address in the browser");
    if (ts.isPropertyAccessExpression(n) && n.name.text === "searchParams" && !REQUEST_URLS.has(n.expression.getText(sf))) {
      say(n, "read searchParams through the destructured page parameter");
    }
    if (
      ts.isBindingElement(n) &&
      (n.propertyName ?? n.name).getText(sf) === "searchParams" &&
      ts.isVariableDeclaration(n.parent.parent) &&
      !REQUEST_URLS.has(n.parent.parent.initializer?.getText(sf) ?? "")
    ) {
      say(n, "searchParams taken from something other than the request");
    }
    if (ts.isPropertyAccessExpression(n) && ["search", "href", "hash"].includes(n.name.text) && /(^|\.)location$/.test(n.expression.getText(sf))) {
      say(n, "location read in the browser");
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ["get", "getAll", "has"].includes(n.expression.name.text) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      (n.arguments[0].text === "error" || n.arguments[0].text === "success")
    ) {
      say(n, `.${n.expression.name.text}("${n.arguments[0].text}") reads the message outside the page filter`);
    }
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "searchParams") say(n, "searchParams handed to a component");
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      for (const param of n.parameters) {
        if (!ts.isObjectBindingPattern(param.name)) continue;
        if (!param.name.elements.some((e) => (e.propertyName ?? e.name).getText(sf) === "searchParams")) continue;
        const typeNode = param.type && ts.isTypeLiteralNode(param.type)
          ? param.type.members.find((m) => m.name?.getText(sf) === "searchParams")
          : undefined;
        try {
          if (!typeNode || !ts.isPropertySignature(typeNode)) throw new Unresolved("searchParams type not written inline");
          keysByFunction.set(n, queryKeys(typeNode.type, sf));
        } catch (e) {
          if (!(e instanceof Unresolved)) throw e;
          say(param, e.message);
        }
      }
    }
    if (ts.isIdentifier(n) && n.text === "searchParams") {
      const fn = enclosingFunction(n);
      const keys = fn ? keysByFunction.get(fn) : undefined;
      const isBindingName = ts.isBindingElement(n.parent) || ts.isPropertySignature(n.parent) || ts.isPropertyAccessExpression(n.parent);
      if (fn && keys && !isBindingName && (keys.has("error") || keys.has("success"))) {
        // Only `const { ... } = await searchParams` (or `?? {}`) is allowed.
        let up: ts.Node = n.parent;
        if (ts.isAwaitExpression(up)) up = up.parent;
        while (ts.isParenthesizedExpression(up)) up = up.parent;
        if (ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) up = up.parent;
        if (ts.isAwaitExpression(n.parent) && ts.isVariableDeclaration(up) && ts.isObjectBindingPattern(up.name)) {
          checkBinding(up, fn);
        } else {
          say(n, "read ?error= / ?success= only as `const { error: rawError } = await searchParams`");
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems;
}

describe("every page passes ?error= / ?success= through a filter", () => {
  const files = listSourceFiles(SRC);

  it("finds the pages that show these messages", () => {
    const showing = files.filter((f) => /pageErrorMessage\(|translateAuthErrorMessage\(/.test(readFileSync(f, "utf8")));
    expect(showing.length).toBeGreaterThanOrEqual(30);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f] as const))("%s", (_label, file) => {
    expect(pageProblems(sourceFile(file))).toEqual([]);
  });
});

// The audit's mutants (AUDIT-B16-r2) and more: each must fail the check.
describe("the checks fail closed", () => {
  const OK = JSON.stringify([...PAGE_ERROR_MESSAGES][0]);
  const FORM = 'String(formData.get("x"))';
  const senderFails = (body: string) => {
    const code = `const OK = ${OK};\nasync function act(formData: FormData) {\n${body}\n}\nact(new FormData());`;
    const sites = sitesIn(ts.createSourceFile("/virtual/actions.ts", code, ts.ScriptTarget.Latest, true), "virtual");
    expect(sites.length, "no site found at all").toBeGreaterThan(0);
    return sites.some((s) => {
      const allowed = s.kind === "error" ? PAGE_ERROR_MESSAGES : PAGE_SUCCESS_MESSAGES;
      return s.messages === null || s.messages.some((m) => m !== "" && !allowed.has(m));
    });
  };

  it.each([
    ["the safe shape passes", "redirect(`/p?error=${encodeURIComponent(OK)}`);"],
    ["a following &next= part passes", 'redirect(`/p?error=${encodeURIComponent(OK)}${formData.has("n") ? `&next=${FORM}` : ""}`);'],
    ["a fixed list in for-of passes", 'for (const m of [OK] as const) redirect(`/p?error=${encodeURIComponent(m)}`);'],
  ])("%s", (_name, body) => {
    expect(senderFails(body.replace("FORM", FORM))).toBe(false);
  });

  it.each([
    ["C1 form text", `redirect(\`/p?error=\${encodeURIComponent(${FORM})}\`);`],
    ["C2 text before the value", `redirect(\`/p?error=Gabim: \${${FORM}}\`);`],
    ["C3 query built in a variable", `const q = \`error=\${${FORM}}\`; redirect(\`/p?\${q}\`);`],
    ["M1 joined with +", 'redirect("/p?error=" + encodeURIComponent(OK));'],
    ["M2 two parts", `redirect(\`/p?error=\${OK}\${${FORM}}\`);`],
    ["M3 +=", `let m = OK; m += ${FORM}; redirect(\`/p?error=\${encodeURIComponent(m)}\`);`],
    ["M5 URLSearchParams", `redirect(\`/p?\${new URLSearchParams({ error: ${FORM} })}\`);`],
    ["M7 getter", `const r = { get error() { return ${FORM}; } }; redirect(\`/p?error=\${encodeURIComponent(r.error)}\`);`],
    ["a text suffix after the value", "redirect(`/p?error=${encodeURIComponent(OK)}!`);"],
    ["searchParams.set", 'const u = new URL("https://x"); u.searchParams.set("error", OK); redirect(u.toString());'],
    ["URLSearchParams.set", 'const p = new URLSearchParams(); p.set("success", OK); redirect(`/p?${p}`);'],
    ["a run-time key", 'const k = "error"; redirect(`/p?${k}=${encodeURIComponent(OK)}`);'],
    ["array destructuring", `const [m] = [${FORM}]; redirect(\`/p?error=\${encodeURIComponent(m)}\`);`],
    ["a catch variable", "try { void 0; } catch (m) { redirect(`/p?error=${encodeURIComponent(String(m))}`); }"],
    ["a for-of over form values", `for (const m of formData.getAll("x")) redirect(\`/p?error=\${encodeURIComponent(String(m))}\`);`],
    ["m++ / reassigned by pattern", `let m = OK; [m] = [${FORM}]; redirect(\`/p?error=\${encodeURIComponent(m)}\`);`],
    ["a changed map", `const MAP: Record<string, string> = { a: OK }; MAP.b = ${FORM}; redirect(\`/p?error=\${encodeURIComponent(MAP[${FORM}])}\`);`],
    ["withQuery with 2 arguments", "redirect(withQuery(`/p`, OK));"],
    ["withQuery with a run-time key", `redirect(withQuery(\`/p\`, ${FORM}, OK));`],
  ])("%s", (_name, body) => {
    expect(senderFails(body)).toBe(true);
  });

  it("M6 a top-level let", () => {
    const code = `let M = ${OK};\nexport function set(v: string) { M = v; }\nasync function act() { redirect(\`/p?error=\${encodeURIComponent(M)}\`); }`;
    const sites = sitesIn(ts.createSourceFile("/virtual/a.ts", code, ts.ScriptTarget.Latest, true), "virtual");
    expect(sites.some((s) => s.messages === null)).toBe(true);
  });

  it("M4 a helper exported with export { }", () => {
    const code = `const OK = ${OK};\nfunction fail(m: string) { redirect(\`/p?error=\${encodeURIComponent(m)}\`); }\nfail(OK);\nexport { fail };`;
    const sites = sitesIn(ts.createSourceFile("/virtual/a.ts", code, ts.ScriptTarget.Latest, true), "virtual");
    expect(sites.some((s) => s.messages === null)).toBe(true);
  });

  it("a withQuery() with a different body", () => {
    const code = "function withQuery(path: string, key: string, message: string) { return `${path}?${key}=${message}`; }";
    const sites = sitesIn(ts.createSourceFile("/virtual/a.ts", code, ts.ScriptTarget.Latest, true), "virtual");
    expect(sites.some((s) => s.messages === null)).toBe(true);
  });

  const page = (body: string, type = "Promise<{ error?: string; success?: string }>") =>
    pageProblems(
      ts.createSourceFile(
        "/virtual/page.tsx",
        `export default async function Page({ searchParams }: { searchParams: ${type} }) {\n${body}\n}`,
        ts.ScriptTarget.Latest,
        true,
      ),
    );

  it("the page shape passes", () => {
    expect(
      page(
        "const { error: rawError, success: rawSuccess } = await searchParams; const error = pageErrorMessage(rawError); const success = pageSuccessMessage(rawSuccess); return <p>{error}{success}</p>;",
      ),
    ).toEqual([]);
  });

  it("a page whose query type has no error/success may read it whole", () => {
    expect(page("const q = await searchParams; return <p>{q.tab}</p>;", "Promise<{ tab?: string }>")).toEqual([]);
  });

  it.each([
    ["M8 raw value printed beside the filter", "const { error: rawError } = await searchParams; const error = pageErrorMessage(rawError); return <p>{error}{rawError}</p>;"],
    ["M9 read without destructuring", "return <p>{(await searchParams).error}</p>;"],
    ["read into a variable", "const sp = await searchParams; return <p>{sp.error}</p>;"],
    ["shorthand, unfiltered", "const { error } = await searchParams; return <p>{error && <b>{error}</b>}</p>;"],
    ["...rest", "const { ...rest } = await searchParams; return <p>{rest.error}</p>;"],
    ["raw value handed to a component", "const { error: rawError } = await searchParams; return <Alert message={rawError} />;"],
    ["raw value in a template", "const { success: rawSuccess } = await searchParams; return <p>{`${rawSuccess}`}</p>;"],
  ])("%s", (_name, body) => {
    expect(page(body).length).toBeGreaterThan(0);
  });

  it("a query type it cannot read", () => {
    expect(page("return null;", "Promise<Record<string, string>>").length).toBeGreaterThan(0);
  });

  const component = (code: string, file = "/virtual/notice.tsx") =>
    pageProblems(ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true));

  it.each([
    ["E14 useSearchParams in a client component", '"use client"; import { useSearchParams } from "next/navigation"; export function N() { const q = useSearchParams(); return <p>{q.get("error")}</p>; }'],
    ["E15 props.searchParams in a component", "export async function N(props: { searchParams: Promise<{ error?: string }> }) { const s = await props.searchParams; return <p>{s.error}</p>; }"],
    ["searchParams handed down as a prop", "export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) { return <N searchParams={searchParams} />; }"],
    ["location.search in the browser", '"use client"; export function N() { return <p>{new URLSearchParams(window.location.search).toString()}</p>; }'],
    [".get(\"error\") on any query", "export function N({ q }: { q: URLSearchParams }) { return <p>{q.get(\"error\")}</p>; }"],
    ["searchParams from another URL", "export function N() { const { searchParams } = new URL(document.URL); return <p>{String(searchParams)}</p>; }"],
  ])("%s", (_name, code) => {
    expect(component(code).length).toBeGreaterThan(0);
  });

  it("a route handler reading its own request passes", () => {
    expect(
      component(
        'export function GET(request: Request) { const { searchParams } = new URL(request.url); return Response.redirect(searchParams.get("next") ?? "/"); }',
        "/virtual/route.ts",
      ),
    ).toEqual([]);
  });

  it("props.searchParams in a page", () => {
    const sf = ts.createSourceFile(
      "/virtual/page.tsx",
      "export default async function Page(props: { searchParams: Promise<{ error?: string }> }) { const sp = await props.searchParams; return <p>{sp.error}</p>; }",
      ts.ScriptTarget.Latest,
      true,
    );
    expect(pageProblems(sf).length).toBeGreaterThan(0);
  });
});
