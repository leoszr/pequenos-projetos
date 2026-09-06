import ts from "typescript";
const reserved = new Set(["tools", "text", "display", "__repl", "globalThis", "Deno", "undefined", "NaN", "Infinity", "__proto__", "constructor", "prototype"]);
export function bindingName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !reserved.has(name) && !name.startsWith("__repl");
}
export type DeclarationKind = "const" | "let" | "var" | "function" | "class" | "import" | "enum";
export interface BindingDeclaration { name: string; declaration: DeclarationKind }
export function declarationMetadata(source: string): BindingDeclaration[] {
  const file = ts.createSourceFile("cell.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = new Map<string, DeclarationKind>();
  const add = (name: ts.BindingName, declaration: DeclarationKind) => {
    if (ts.isIdentifier(name)) bindings.set(name.text, declaration);
    else for (const element of name.elements) if (ts.isBindingElement(element)) add(element.name, declaration);
  };
  for (const node of file.statements) {
    if (ts.isVariableStatement(node)) {
      const kind: DeclarationKind = node.declarationList.flags & ts.NodeFlags.Const ? "const" : node.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      node.declarationList.declarations.forEach(d => add(d.name, kind));
    }
    if (ts.isFunctionDeclaration(node) && node.name) bindings.set(node.name.text, "function");
    if (ts.isClassDeclaration(node) && node.name) bindings.set(node.name.text, "class");
    if (ts.isEnumDeclaration(node)) bindings.set(node.name.text, "enum");
    if (ts.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      if (node.importClause.name) bindings.set(node.importClause.name.text, "import");
      const imported = node.importClause.namedBindings;
      if (imported && ts.isNamespaceImport(imported)) bindings.set(imported.name.text, "import");
      else imported?.elements.filter(e => !e.isTypeOnly).forEach(e => bindings.set(e.name.text, "import"));
    }
  }
  for (const name of bindings.keys()) if (!bindingName(name)) throw new Error(`Reserved/unsupported binding: ${name}`);
  return [...bindings].map(([name, declaration]) => ({ name, declaration }));
}
export function declarations(source: string): string[] {
  return declarationMetadata(source).map(binding => binding.name);
}
/** Only import declarations move to module scope; bindings and expressions stay untouched. */
export function codeModule(source: string): string {
  const file = ts.createSourceFile("code-mode-input.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importNodes = file.statements.filter(ts.isImportDeclaration);
  const importLines = importNodes.flatMap(node => {
    const startLine = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    return source.slice(node.getStart(file), node.end).split("\n").map((text, index) => ({ text, original: startLine + index }));
  });
  let body = source;
  for (const node of [...importNodes].reverse()) {
    body = body.slice(0, node.getStart(file)) + body.slice(node.getStart(file), node.end).replace(/[^\r\n]/g, " ") + body.slice(node.end);
  }
  const lines = [...importLines.map(line => line.text), "export default async function() {", ...body.split("\n"), "}"];
  const origins: Array<number | undefined> = [...importLines.map(line => line.original), undefined, ...body.split("\n").map((_, line) => line), undefined];
  const map = { version: 3, file: "operation.ts", sources: ["code-mode-input.ts"], sourcesContent: [source], names: [], mappings: sourceMappings(origins) };
  return `${lines.join("\n")}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
}
function sourceMappings(origins: Array<number | undefined>): string {
  let previousSource = 0;
  let previousLine = 0;
  let previousColumn = 0;
  return origins.map(original => {
    if (original === undefined) return "";
    const segment = [0, -previousSource, original - previousLine, -previousColumn].map(vlq).join("");
    previousSource = 0; previousLine = original; previousColumn = 0;
    return segment;
  }).join(";");
}
const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function vlq(value: number): string {
  let encoded = "";
  let digit = value < 0 ? ((-value) << 1) | 1 : value << 1;
  do {
    let next = digit & 31;
    digit >>>= 5;
    if (digit) next |= 32;
    encoded += base64[next];
  } while (digit);
  return encoded;
}
