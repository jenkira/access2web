// Static check on handler source. It is a filter, not the security boundary:
// the sandbox and the runtime SQL guard hold even when this check is skipped.
import ts from "typescript";

const BANNED = new Set(["eval", "Function", "require", "process", "globalThis", "window", "self", "fetch",
  "XMLHttpRequest", "WebAssembly", "importScripts", "Reflect", "Proxy", "std", "os"]);

export function checkHandler(source) {
  const sf = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.ES2020, true);
  const problems = [];
  const at = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isExportAssignment(n)) {
      problems.push(`line ${at(n)}: import and export are not allowed`);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      problems.push(`line ${at(n)}: dynamic import is not allowed`);
    }
    if (ts.isIdentifier(n) && BANNED.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      problems.push(`line ${at(n)}: ${n.text} is not available to handlers`);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "query"
        && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "db") {
      const a = n.arguments[0];
      const literal = a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a));
      if (!literal) problems.push(`line ${at(n)}: db.query needs a literal SQL string; pass values as parameters`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems;
}

export function transpile(source) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
}
