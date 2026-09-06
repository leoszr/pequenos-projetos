# Integração com Pi 0.85.1

`pi-repl-notebook` é uma extensão Pi que registra uma única tool pública: `repl_notebook`.

Ela oferece dois caminhos:

- `mode: "code"`: operação TypeScript autocontida em um kernel descartável.
- `mode: "notebook"`: cells TypeScript com bindings persistentes na sessão Pi.
- tools Pi diretas continuam sendo o caminho recomendado para operações simples e interativas.

## Instalação

O `package.json` declara `./src/index.ts` em `pi.extensions`. Para testar este checkout:

```sh
pi -e .
```

O carregamento e `/repl status` não iniciam Deno, kernel, bridge ou sockets. O primeiro comando que precisa do runtime faz a inicialização lazy.

## Tool `repl_notebook`

Toda requisição exige `mode` e `action`. O schema rejeita propriedades desconhecidas. O roteador também valida os campos permitidos e obrigatórios de cada discriminante.

| Ação | Modos | Campos adicionais |
|---|---|---|
| `exec` | code/notebook | `code`, `yield-time_ms?` |
| `wait` | code/notebook | `execution_id`, `yield-time_ms?`, `cursor?` |
| `interrupt`, `terminate` | code/notebook | `execution_id` |
| `status`, `diagnostics` | code/notebook | `execution_id?` |
| `tools` | code/notebook | nenhum |
| `bindings`, `snapshot`, `checkpoint`, `restart` | notebook | nenhum |
| `reset` | notebook | `scope: "session"` |
| `pin`, `unpin` | notebook | `names` |
| `release`, `prune` | notebook | `names`, `scope: "bindings"` |
| `profile` | notebook | `operation: "save" | "list" | "load"`; `name` em save/load |
| `project` | notebook | `operation: "status" | "promote" | "rollback"`; gerações explícitas em mutações |
| `journal` | notebook | `operation: "list" | "export"`; `cursor?` e `limit?` em list |

Exemplos:

```json
{"mode":"code","action":"exec","code":"return 6 * 7"}
```

```json
{"mode":"notebook","action":"exec","code":"const answer: number = 42"}
```

```json
{"mode":"notebook","action":"wait","execution_id":"<id>","cursor":0,"yield-time_ms":5000}
```

Uma resposta `yielded` representa trabalho ainda ativo. Use `wait` com o `execution_id` e envie o `next_cursor` anterior para não repetir outputs.

`prune` pertence ao contrato público, mas o supervisor atual ainda não implementa seu dry-run/apply próprio. A extensão falha explicitamente em vez de tratá-lo silenciosamente como `release`.

## Comando `/repl`

```text
/repl
/repl status
/repl enable
/repl disable
/repl policies
/repl limits
/repl restart
/repl checkpoint
/repl reset
/repl terminate <execution_id> [notebook|code]
/repl profile [list|save <name>|load <name>]   # alias: profiles
/repl journal [export|<cursor> [<limit>]]
/repl journal-export  # alias: export
/repl bindings  # aliases: state, estado
/repl snapshot
/repl project [status|promote <expected_generation>|rollback <expected_generation> <target_generation>]
/repl diagnostics [execution_id] [notebook|code]
/repl {"mode":"notebook","action":"bindings"}
```

Cada subcomando nomeado apenas monta a requisição `repl_notebook` equivalente e delega ao mesmo roteador da tool; o comportamento (incluindo erros) é idêntico ao do JSON bruto.

Erros de administração são capturados e mostrados como notificação. `disable` e `session_shutdown` aguardam o shutdown do runtime. Trocar o modelo Pi não reinicia nem altera o Notebook.

## Provider cooperativo para `tools.*`

A API pública do Pi 0.85.1 expõe metadata por `pi.getAllTools()` e atividade por `pi.getActiveTools()`. Ela não expõe uma invocação genérica que preserve automaticamente `tool_call`, `tool_result`, aprovação e middleware.

Por isso, a integração emite o evento síncrono:

```ts
pi.events.emit("pi-repl-notebook:provider", {
  accept(provider) { /* ToolProvider autorizado pelo host */ }
});
```

Outra extensão pode responder chamando `accept(provider)` **sincronamente**, antes de qualquer `await`. O provider deve fornecer:

1. definições `ToolDefinition` reais;
2. capacidades explícitas por tool;
3. `preflight` de política/aprovação;
4. `invoke` abortável com o `AbortSignal` recebido.

Sem provider, `tools.*` fica indisponível de forma fechada. `action: "tools"` retorna somente definições simultaneamente ativas, anunciadas pelo provider e permitidas no modo. A descoberta usa a metadata oficial atual do Pi.

Veja [`../examples/cooperative-tools.ts`](../examples/cooperative-tools.ts).

### Limite importante

Invocar `ToolDefinition.execute` diretamente é uma integração cooperativa do host. Isso **não preserva automaticamente** middleware registrado nos eventos do Pi. A política relevante deve ser migrada para `preflight`/`invoke`, ou a tool não deve ser exposta ao runtime. Não existe fallback que execute built-ins pela metadata.

## Colisões e coexistência

No `session_start`, a extensão consulta `pi.getAllTools()`. Se `repl_notebook` já existir, ela não registra override, permanece desabilitada e mostra aviso. Tools com outros nomes, inclusive `notebook`, permanecem intactas. A extensão nunca chama `pi.setActiveTools()`.

## Estado

Por padrão, o estado fica em:

```text
~/.pi/agent/repl-notebook/<sha256-do-cwd>/
```

Sessões continuam privadas pelo hash interno do `sessionId`. Profiles e gerações de projeto são compartilhados somente dentro do mesmo hash de `cwd`.

`PI_REPL_STATE_DIR` substitui explicitamente a raiz base, mas o particionamento por hash do projeto continua ativo. A extensão não lê configuração do projeto para escolher o storage.

## Output e limites

A fronteira Pi converte:

- texto, stdout, stderr e erros para conteúdo textual;
- `image/png`, `image/jpeg`, `image/webp` e `image/gif` para conteúdo de imagem Pi;
- MIME types, origem, atribuição e metadata para `details` bounded.

HTML nunca é executado. Respostas, attachments, outputs e metadata são truncados quando ultrapassam os limites configurados. O limite padrão da resposta é 1 MiB.

## Segurança

Code Mode e Notebook Mode **não são sandbox**. O processo Deno pode acessar recursos permitidos ao usuário do Pi. O token HTTP protege o bridge local contra chamadas externas casuais; ele não restringe código executado dentro do kernel.
