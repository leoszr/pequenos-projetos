import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingName, codeModule, declarations } from "../src/execution/source.ts";

test("discovers top-level declarations without treating nested declarations as bindings", () => {
  assert.deepEqual(declarations(`
    import main, { read as load, type Meta } from "./dep.ts";
    import * as api from "./api.ts";
    const { a, nested: [b] } = value;
    let c = 1;
    function fn() { const hidden = 1; }
    class Box {}
    enum Choice { A }
  `), ["main", "load", "api", "a", "b", "c", "fn", "Box", "Choice"]);
});

test("rejects internal and prototype-polluting binding names", () => {
  assert.equal(bindingName("safe_$"), true);
  for (const name of ["tools", "text", "display", "__repl", "__proto__", "constructor", "prototype", "1bad"]) {
    assert.equal(bindingName(name), false, name);
  }
});

test("moves only static imports to module scope and preserves line count", () => {
  const source = `// leading\nimport { x } from "./dep.ts";\nconst y: number = x;\nreturn { y };`;
  const generated = codeModule(source);
  assert.match(generated, /^import \{ x \} from "\.\/dep\.ts";/);
  assert.match(generated, /export default async function\(\)/);
  assert.match(generated, /const y: number = x;/);
  assert.match(generated, /return \{ y \};/);
  assert.match(generated, /sourceMappingURL=data:application\/json;base64,/);
});
