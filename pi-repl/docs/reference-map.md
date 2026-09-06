# Mapa de Referência Técnica: Fontes Igor e Prime

Mapeamento conceitual e arquitetural dos repositórios de referência `/tmp/pi-repl-refs/igor` e `/tmp/pi-repl-refs/prime`, analisados diretamente a partir do código-fonte em seus respectivos commits `main HEAD`.

---

## 1. Identificação e Metadados dos Repositórios

| Repositório | Caminho Local | Commit HEAD | Mensagem do Commit | Licença |
| :--- | :--- | :--- | :--- | :--- |
| **Igor** (`howaboua-pi-stuff`) | `/tmp/pi-repl-refs/igor` | `7021ae48e8efe36a3becc5830d529696ff798e5e` | `Version Packages (#379)` | **MIT** (Copyright (c) 2026 Igor Warzocha) |
| **Prime** (`prime-agent`) | `/tmp/pi-repl-refs/prime` | `9c54a35dac3a2ad17910074d66664859ea175666` | `chore: prepare v0.9.2 release (#2067)` | **MIT** (Copyright (c) 2025 Mario Zechner, Copyright (c) 2026 Prime Intellect) |

Ambas as bases utilizam licença permissiva MIT, permitindo reutilização de arquitetura, contratos e padrões de protocolo, sem necessidade de cópia direta de código.

---

## 2. Igor: Distinção de Modelos de Execução e Dependências

O subsistema de execução do Igor reside no pacote `packages/pi-codex-conversion`. Existem duas modalidades distintas:
1. **Code Mode (V8 nativo):** Sandbox isolada em processo Rust (`codex-code-mode-host`) com isolate V8 puro, sem acesso nativo a disco, rede ou variáveis de ambiente.
2. **Notebook Mode (Deno Jupyter):** **Não é sandbox**. É um runtime real de TypeScript/JavaScript completo, persistente e irrestrito sobre o motor Deno (`deno jupyter`). Ele possui acesso direto ao sistema de arquivos, rede, APIs Web completas, subprocessos e pacotes npm, compartilhando o namespace `globalThis` entre as chamadas `exec` sucessivas.

### 2.1 Import Edges entre Componentes (Grafo de Dependências Internas)

#### A. Arestas `notebook-mode` → `code-mode`
O Notebook Mode foi construído no Igor aproveitando contratos e tipagens preexistentes do Code Mode. As referências diretas nos fontes são:

| Arquivo Origem (`src/tools/notebook-mode/`) | Arquivo Alvo (`src/tools/code-mode/`) | Linhas Âncora | Símbolos / Tipos Importados |
| :--- | :--- | :--- | :--- |
| `bridge-protocol.ts` | `types.ts` | Linha 2 | `CodeModeToolIdentity`, `NotebookMemoryUsage`, `RuntimeContentItem` |
| `bridge-server.ts` | `types.ts` | Linha 3 | `CodeModeToolIdentity`, `NotebookMemoryUsage`, `RuntimeContentItem` |
| `cell.ts` | `types.ts` | Linha 2 | `RuntimeContentItem`, `ToolExecutionContext` |
| `client.ts` | `shared-runtime.ts` | Linha 1 | `CodeModeExecutionClient`, `NotebookRuntimeOptions` |
| `client.ts` | `trace-render-state.ts` | Linha 2 | `CodeModeNestedRenderStore` |
| `client.ts` | `types.ts` | Linhas 3–9 | `CodeModeToolDefinition`, `NotebookControlRequest`, `NotebookControlResult`, `RuntimeResponse`, `ToolExecutionContext` |
| `execution-runtime.ts` | `custom-tool-prompt.ts` | Linha 1 | `formatCodeModeToolHelp` |
| `execution-runtime.ts` | `delegate-runtime.ts` | Linha 2 | `CodeModeDelegateRuntime` |
| `execution-runtime.ts` | `host-protocol.ts` | Linha 7 | `HostDelegateCancelEvent`, `HostDelegateEmitEvent`, etc. |
| `execution-runtime.ts` | `tool-source.ts` | Linha 8 | `directToolYieldTime` |
| `execution-runtime.ts` | `trace-render-state.ts` | Linha 9 | `CodeModeNestedRenderStore` |
| `execution-runtime.ts` | `tool-identity.ts` | Linha 14 | `codeModeGlobalName`, `codeModeNameForToolIdentity` |
| `execution-runtime.ts` | `types.ts` | Linhas 15–21 | `CodeModeToolDefinition`, `RuntimeResponse`, `ToolExecutionContext`, etc. |
| `journal.ts` | `types.ts` | Linha 4 | `RuntimeContentItem` |
| `jupyter-kernel.ts` | `types.ts` | Linha 6 | `RuntimeContentItem` |
| `jupyter-output.ts` | `types.ts` | Linha 1 | `RuntimeContentItem` |
| `lifecycle-result.ts` | `types.ts` | Linha 1 | `NotebookMemoryUsage` |
| `lifecycle.ts` | `types.ts` | Linha 8 | `NotebookControlResult`, `NotebookMemoryUsage` |
| `notebook-diagnostics.ts` | `types.ts` | Linha 2 | `NotebookControlResult` |
| `profile-lifecycle.ts` | `types.ts` | Linha 2 | `NotebookControlResult`, `ToolExecutionContext` |
| `recovery.ts` | `types.ts` | Linha 2 | `NotebookControlResult`, `ToolExecutionContext` |
| `session-runtime.ts` | `shared-runtime.ts` | Linha 2 | `NotebookRuntimeOptions` |
| `session-runtime.ts` | `types.ts` | Linha 3 | `NotebookMemoryUsage`, `ToolExecutionContext` |
| `session-startup.ts` | `shared-runtime.ts` | Linha 3 | `NotebookRuntimeOptions` |

#### B. Arestas `code-mode` → `adapter` / `providers` / `root`
O `src/tools/code-mode/` atua como subsistema compartilhado, mas é orquestrado e consumido pelos adapters e providers:

| Arquivo Origem | Arquivo Alvo (`adapter`/`providers`/`root`) | Linhas Âncora | Papel da Relação |
| :--- | :--- | :--- | :--- |
| `code-mode.ts` (raiz) | `tools/code-mode/tool-identity.ts` | Linhas 6–7 | Re-exporta `codeModeNameForToolIdentity` |
| `code-mode.ts` (raiz) | `tools/code-mode/types.ts` | Linha 16 | Exporta tipos públicos para extensões filhas |
| `code-mode-extension-tools.ts` | `tools/code-mode/tool-identity.ts` | Linha 6 | Registro de ferramentas adicionais via Symbol global |
| `adapter/code-mode.ts` | `tools/code-mode/tools.ts` | Linhas 4–9 | Inicializa `registerCodexCodeMode` |
| `adapter/active-tools.ts` | `tools/code-mode/exec-contract.ts` | Linha 3 | `CODE_MODE_EXEC_CONSTRAINED_SAMPLING` para filtros de tools |
| `adapter/compaction/compaction.ts`| `tools/code-mode/exec-contract.ts` | Linha 19 | `CODE_MODE_EXEC_GRAMMAR_INPUTS` em compactação de contexto |
| `providers/code-mode-proxy-provider.ts` | `adapter/activation/runtime-plan.ts` | Linhas 10–12, 187 | Roteia stream para proxy Responses Lite se modo for `code` ou `notebook` |

---

### 2.2 Inventário de Componentes de `src/tools/code-mode/`

Abaixo está o mapa de todos os arquivos de `src/tools/code-mode/`, com categorização arquitetural, linhas-âncora e a decisão de extração para o novo backend:

| Componente / Arquivo | Linhas Âncora | Descrição e Papel Real | Decisão: Mínimo Extraído vs Não Portar |
| :--- | :--- | :--- | :--- |
| **Types & Contratos**<br>`types.ts`<br>`tool-source.ts` | `types.ts:1-120`<br>`tool-source.ts:8-25` | Tipos fundamentais: `ToolExecutionContext`, `RuntimeResponse`, `RuntimeContentItem`, `NotebookControlResult`. | **Mínimo Extraído**: Extrair apenas tipos essenciais de execução e contexto (`ExecutionIdentity`, `KernelOutput`, `KernelResult`). Descartar acoplamento com classes Codex. |
| **Shared Runtime & Registry**<br>`shared-runtime.ts`<br>`tools.ts`<br>`tool-identity.ts`<br>`tool-events.ts` | `shared-runtime.ts:23-52`<br>`tools.ts:23, 111`<br>`tool-identity.ts:1-35` | `SharedCodeModeRuntime` gerencia providers ativos, lazy load do `client.ts` do notebook e registro em `globalThis` via Symbol. | **Mínimo Extraído**: Manter factory enxuta de runtime (`KernelBackend`). **Não Portar**: Sistema complexo de multi-providers dinâmicos e Symbol global de extensão do Igor. |
| **Context & Delegation**<br>`delegate-runtime.ts`<br>`host-delegation.ts`<br>`host-cell-operations.ts` | `delegate-runtime.ts:54-62, 155`<br>`host-delegation.ts:22-30`<br>`host-cell-operations.ts:26-76` | Despacha tool calls emitidas dentro da execução (`tools.<name>()`) para o host Pi, ligando cellId ao `ToolExecutionContext`. | **Mínimo Extraído**: Protocolo de bridge de ferramentas (através de `bridge-server.ts` HTTP ou stdio). Descartar as camadas de abstração redundantes do host Rust. |
| **Public Tools**<br>`public-tools.ts`<br>`notebook-tool.ts`<br>`custom-tools.ts`<br>`custom-tool-runner.ts`<br>`custom-tool-prompt.ts` | `public-tools.ts:108-158`<br>`notebook-tool.ts:47-90`<br>`custom-tools.ts:24`<br>`custom-tool-prompt.ts:14-25` | Registro no Pi das ferramentas de modelo: `exec`, `wait` e `notebook` (com ações status, pin, restart, etc.). Leitura de TOML para custom tools. | **Mínimo Extraído**: Ferramenta `exec` e ferramenta de lifecycle `notebook`. **Não Portar**: Custom tools baseadas em TOML (`smol-toml`) e runners de scripts inline legados. |
| **Traces & Rendering**<br>`trace-rendering.ts`<br>`trace-render-state.ts`<br>`trace-store.ts`<br>`trace-values.ts`<br>`call-rendering.ts`<br>`result-rendering.ts`<br>`render-tracker.ts`<br>`render-content.ts` | `trace-render-state.ts:1-40`<br>`call-rendering.ts:10-33`<br>`result-rendering.ts:41-89`<br>`trace-rendering.ts:31-71` | Renderizadores de UI do Pi TUI: árvore de tool calls aninhadas, visualização de código colapsável e avisos de limite de memória heap. | **Não Portar no Kernel Backend**: Manter renderização desacoplada do core do kernel. A emissão de eventos deve ser genérica (`KernelOutput`), sem amarrar à TUI do Igor. |
| **Preflight & Approval**<br>`nested-tool-preflight.ts`<br>`preflight-protocol.ts`<br>`exec-contract.ts` | `nested-tool-preflight.ts:93-105`<br>`preflight-protocol.ts:3`<br>`exec-contract.ts:1-20` | Protocolo de pré-checagem entre extensões para aprovação de uso de ferramentas e gramáticas restritas. | **Não Portar**: Específico do ecossistema de extensões acopladas do Igor. |
| **Host V8 (Rust)**<br>`binary.ts`<br>`host-client.ts`<br>`host-connection.ts`<br>`host-process.ts`<br>`host-protocol.ts`<br>`host-session.ts`<br>`host-assets.ts`<br>`install-host.ts` | `binary.ts:35, 78`<br>`host-client.ts:66-156`<br>`install-host.ts:46-79`<br>`host-protocol.ts:1-80` | Infraestrutura completa para baixar e rodar o binário `codex-code-mode-host` (sandbox Rust/V8 com framing IPC). | **Não Portar**: Totalmente dispensável para o backend Jupyter/Deno persistente ou REPL Python. |

---

### 2.3 Taxonomia de Dependências NPM

Classificação objetiva das dependências de `pi-codex-conversion/package.json`:

1. **Essenciais para o Runtime Notebook Deno / Jupyter**:
   - `zeromq` (v6.6.0): Sockets ZeroMQ (`Dealer`/`Subscriber`) para comunicação no protocolo Jupyter Wire (`jupyter-kernel.ts:4`).
   - `undici` (v8.10.0): Download robusto do runtime Deno binário (`deno-binary.ts:1-15`).
   - `unzipper` (v0.12.5): Extração do arquivo ZIP da release do Deno (`deno-binary.ts:20-35`).
   - `proxy-from-env` (v2.1.0): Respeita proxies corporativos no download (`deno-binary.ts:18`).
   - `node:http`, `node:crypto`, `node:net`, `node:child_process` (Node.js stdlib): Bridge local HTTP e geração de chaves HMAC SHA-256.

2. **Genéricas / Ecossistema Pi**:
   - `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`: Integração com o harness do Pi.
   - `typebox`: Validação de JSON Schema das ferramentas.

3. **Específicas de Provider / Descartáveis para REPL**:
   - `openai`: SDK OpenAI para Responses e áudio (`src/voice/`). Não tem utilidade no REPL.
   - `partial-json`: Parse de tool call streaming da OpenAI (`src/providers/openai-responses/`).
   - `js-tiktoken`: Contagem de tokens para truncamento de contexto OpenAI (`src/adapter/compaction/`).

4. **Históricas / Legadas / Não Portar**:
   - `smol-toml`: Parsing de manifests TOML de custom tools.
   - `tree-sitter-bash` e `web-tree-sitter`: Interceptação legada de shell AST (`src/shell/bash.ts`).
   - `selfsigned` e `ws`: Servidor HTTPS local e WebSockets para o painel de voz LAN (`src/voice/lan/`).

---

## 3. Prime: Padrões Reais de Engenharia do REPL Runtime

O Prime implementa seu REPL em duas pontas simétricas:
- **Host (TypeScript)**: `packages/coding-agent/src/core/kernel/repl-manager.ts` (`ReplKernelManager`).
- **Runtime (Python)**: `prime-agent-runtime/src/rlm/repl.py` e especificado em `repl.md`.

### 3.1 Lifecycle (Ciclo de Vida)

1. **Inicialização e Handshake**:
   - O host localiza ou provisiona o Python adequado via `ensureKernelPython()` (gerenciado via virtualenv / `uv`).
   - O subprocesso é iniciado como `python -m rlm.repl` com descritores de stdin/stdout/stderr em pipes (`stdio: ["pipe", "pipe", "pipe"]`).
   - O processo filho emite exatamente um evento inicial de handshake: `{"event":"ready","protocol":3,"python":"3.13.x"}`. Nenhum banner ou texto precede esse frame.
   - O host rejeita qualquer versão de protocolo diferente de `3` e cancela a inicialização caso o frame não chegue em até `30_000 ms`.
2. **Estados do Gerenciador**:
   - Estados: `idle` → `starting` → `running` → `shutdown`.
   - Utiliza um contador de geração (`startGeneration`). Qualquer encerramento ou reinicialização incrementa a geração, invalidando tentativas de boot obsoletas e evitando vazamento de callbacks assíncronos.
3. **Serialização Estrita de Requisições**:
   - Todas as requisições (`execute`, `snapshot`, `restore`, `list_names`) são enfileiradas através de uma promise encadeada (`executionQueue`).
   - O runtime Python possui um único event loop asyncio e executa estritamente uma requisição por vez (exceto `interrupt` e `host_reply`, que são processados fora de fila na thread leitora).
4. **Encerramento Limpo e Tolerância a Falhas**:
   - `shutdown`: envia a mensagem `{"type":"shutdown"}` ou encerra o `stdin`. O runtime finaliza grupos de processos pendentes (`rlm.bash`), para o loop e sai com código 0.
   - Antes do encerramento final, se um snapshot estiver configurado, o host executa uma gravação de estado com prioridade (`flushSnapshotForDispose`), bloqueando novos comandos externos.
   - `kill`: encerra forçadamente via `SIGKILL` e limpa referências no registro de kernels ativos (`liveKernels`).
   - Processos órfãos são registrados no `orphan-process-journal` do Prime com o PID pai para limpeza pós-crash.

### 3.2 Protocolo de Comunicação

1. **Formato de Linha (ndjson)**:
   - Formato textual em JSON delimitado por quebra de linha (`\n`), codificação UTF-8 pura.
   - Escrita atômica: as mensagens do runtime passam por um lock dedicado (`_write_lock`) e envio completo via `os.write(_protocol_fd, buffer)` em um único descritor duplicado antes da inicialização (`_protocol_fd = os.dup(1)`).
2. **Isolamento de Descritores de Arquivo**:
   - `fd 0 (stdin)`: redirecionado internamente para `/dev/null` após a thread de leitura do protocolo ser inicializada. Isso impede que comandos interativos (ex: `input()`) roubem frames do protocolo e travem o agente.
   - `fd 1 (stdout)` e `fd 2 (stderr)`: redirecionados para pipes dedicados no Python. Threads de bomba lêem esses descritores e os encapsulam como eventos `stdout`/`stderr` do protocolo com `id: null`. Dessa forma, chamadas C, `os.write` direto ou subprocessos nunca quebram o framing JSON do protocolo principal.
3. **Host Bridge (`host_request` / `host_reply`)**:
   - O runtime pode consultar capacidades do host no meio da execução de uma célula com `await rlm.repl.host_request(data)`.
   - Gera um evento `{"event":"host_request","id":str,"data":{...}}`.
   - O host despacha para os handlers registrados (como `rlm.run` para subagentes, busca de modelos, etc.) e responde com `{"type":"host_reply","id":str,"data":{"status":"ok","result":{...}}}`.
   - A resposta do host é despachada diretamente pela thread de leitura do Python para uma Future asyncio pendente, sem passar pela fila serializada de células, evitando deadlock.

### 3.3 Output e Atribuição de Fluxos

1. **Atribuição Precisa via Contexto**:
   - O runtime rastreia o ID da célula ativa através de `contextvars.ContextVar("_current_cell")`.
   - Como `ContextVar` é propagada automaticamente para novas tasks de `asyncio`, tarefas em segundo plano iniciadas por uma célula continuam atribuindo suas saídas ao ID daquela célula, mesmo se a célula em si já tiver terminado.
   - Threads criadas pelo usuário iniciam com contexto limpo e emitem saídas com `id: null`.
2. **Eventos Estruturados**:
   - `stdout` / `stderr`: fragmentos de texto gerados por prints ou logging.
   - `result`: representação textual (`repr()`) da expressão terminal da célula, quando esta não avalia para `None`. O valor é simultaneamente atribuído à variável `_` no namespace global.
   - `display`: acionado via `emit(dict_de_mimes)`. Permite enviar dados ricos (MIME `application/vnd.prime.diff+json`, imagens, anexos ou payloads customizados) encapsulados em JSON estrito.
   - `error`: emitido em caso de exceção, contendo `ename`, `evalue` e a lista formatada de strings do `traceback`. Os frames internos do runtime (`repl.py`) são limpos do stack trace, deixando apenas o código da célula (`<cell-N>`) e das bibliotecas chamadas.
3. **Drenagem e Barreira (Fencing)**:
   - Antes de emitir o evento conclusivo `done`, o runtime sincroniza e drena as saídas pendentes nos canais de Python e envia um marcador de cerca nos pipes de baixo nível dos descritores, garantindo que toda a saída gerada pela célula chegue ao host antes do sinal de conclusão.

### 3.4 Snapshot e Persistência de Estado

1. **Mecanismo de Serialização**:
   - Utiliza a biblioteca `dill` (em modo recursivo) para serializar o dicionário `__main__.__dict__` variável por variável.
2. **Filtros e Nomes Reservados**:
   - Nomes com prefixo `_` são ignorados.
   - Conjunto fixo de isolamento (`_ALWAYS_SKIP`): `{"rlm", "mcp", "bash", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}`.
   - Nomes nunca restaurados (`_RESTORE_SKIP`): `{"In", "Out", "get_ipython"}`.
3. **Controle Orçamentário e Pruning**:
   - Limite por variável (`max_variable_bytes`, padrão 16 MiB) e limite agregado (`max_bytes`, padrão 256 MiB).
   - Se uma variável ultrapassar o limite, ela é listada em `skipped`.
   - Modo `prune_oversized`: quando ativado, variáveis que excedem o limite individual são excluídas do namespace para aliviar a memória antes da gravação.
4. **Atomicidade e Integridade**:
   - O payload é escrito em arquivo temporário no mesmo sistema de arquivos e movido atomicamente via `os.replace` para o caminho de destino.
   - Um arquivo de manifesto JSON (`manifest_path`) registra metadados: versão, variáveis salvas, variáveis podadas, bytes e timestamp.
5. **Restauração Tolerante a Falhas**:
   - `restore` lê o arquivo e recupera cada variável de forma independente em blocos `try/except`. Se uma função ou classe não puder ser desserializada, as demais variáveis continuam sendo restauradas, reportando as falhas em `failed`.

### 3.5 Cancelamento e Interrupção

1. **Requisição `interrupt`**:
   - Enviada pelo host como `{"type":"interrupt","id"?:str}`.
   - Pode especificar o ID exato da execução ativa ou omiti-lo para interromper o que estiver rodando (ou a próxima requisição enfileirada).
2. **Entrega de Sinal em Sistemas Unix**:
   - A thread leitora do Python recebe a mensagem e dispara um `signal.pthread_kill` direcionado com `signal.SIGINT` para a thread do loop asyncio.
   - Se a thread estava em código síncrono bloqueante (ex: loop de cálculo ou syscall sujeita a EINTR), o tratador de sinal do Python lança `KeyboardInterrupt` imediatamente.
3. **Entrega em Await e no Windows**:
   - Se o loop estiver suspenso em um `await` ou se a plataforma for Windows (sem suporte a `pthread_kill`), o tratador identifica a task asyncio da célula ativa e aciona `task.cancel()`.
   - O runtime intercepta a interrupção/cancelamento e formata a saída como um evento `error` com `ename: "KeyboardInterrupt"`, seguido de `{"event":"done","id":...,"status":"error"}`.
4. **Resiliência do Host contra Travamentos**:
   - O host não descarta a execução ativa imediatamente no abort: ele aciona `interrupt()` e aguarda uma janela de tolerância (`KERNEL_ABORT_GRACE_MS = 3000 ms`).
   - Apenas após a chegada do frame `done` (ou após esgotar o prazo com erro `KernelBusyAfterInterruptError`), o slot é liberado para a próxima célula, impedindo que requisições subsequentes colidam com uma execução ainda ativa no processo.
