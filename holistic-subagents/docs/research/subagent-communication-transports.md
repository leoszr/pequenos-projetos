# Transporte de mensagens, estado e artifacts entre agentes/subagentes

Nota de pesquisa em fontes primárias. Pergunta original: *como subagentes se
comunicam atualmente e se todas as interações deveriam usar arquivos em `/tmp`*.

- Data de acesso de todas as URLs: **2026-08-02**.
- Escopo: documentação/spec/source oficial de Anthropic Claude Code (subagents e
  agent teams), OpenAI (Agents SDK e Codex), Google A2A, Microsoft AutoGen e
  LangGraph. Nenhum blog secundário foi usado como evidência.
- Estrutura: taxonomia (seção 1), como este projeto transporta hoje (seção 2),
  achados por sistema (seção 3), comparação explícita messages × state ×
  artifacts (seção 4), análise factual da proposta `/tmp` (seção 5) e, **por
  último e claramente separada**, a recomendação específica deste projeto
  (seção 6, marcada como opinião).

---

## 1. Taxonomia: quatro canais distintos

As fontes primárias separam consistentemente quatro coisas que costumam ser
confundidas sob o guarda-chuva "comunicação entre agentes":

| Canal | O que carrega | Exemplos nas fontes |
|---|---|---|
| **Control plane** | Lifecycle de tarefas/sessões: criação, estados, cancelamento, notificações, permissões | A2A `tasks/*` (JSON-RPC), eventos `pane.agent_status_changed`/`agent_settled` do Herdr, hooks `TaskCreated`/`TaskCompleted`/`TeammateIdle` do Claude Code |
| **Mensagens conversacionais** | Turnos de texto/estruturados entre pai e filho; pequenos, frequentes, entram no contexto do LLM | A2A `message/send`, `SendMessage` dos agent teams, `agent.prompt` + callbacks no holistic, handoffs do Agents SDK, `GroupChatMessage` do AutoGen |
| **Estado durável** | O que precisa sobreviver a restarts e ser consultado: transcrições, task lists, checkpoints, sessões | LangGraph checkpointers/stores, OpenAI `Session`/`conversation_id`, A2A `Task` (server-side), task list em JSON dos agent teams, entries da sessão Pi no holistic |
| **Artifacts grandes** | Outputs volumosos (logs, diffs, imagens, docs) que não devem trafegar inline em mensagens | A2A `Artifact` com `FilePart` (URI para arquivos grandes), arquivos do worktree, artifacts publicados do Claude Code |

---

## 2. Como o holistic-subagents transporta hoje (contexto local)

Leitura de `src/pi/runtime.ts`, `src/domain/service.ts`, `src/protocol/brief.ts`,
`src/protocol/callback.ts`, `src/herdr/client.ts` e
`skills/holistic-subagents/references/delegation-contract.md`:

- **Control plane**: `HerdrClient` fala **NDJSON** (uma mensagem JSON por
  linha, separada por `\n` — `takeMessages` faz split por linha e
  `JSON.parse`, com erro explícito "Herdr sent invalid NDJSON") sobre **Unix
  domain socket** (`HERDR_SOCKET_PATH`); usa `pane.get` e `agent.prompt`, com
  subscriptions de `pane.agent_status_changed` em conexão dedicada. O
  `pane.read` que a v1 usava para ler o pane foi removido em `17464b13` e não
  faz parte do contrato atual.
- **Mensagens pai → filho**: texto injetado na sessão do filho via
  `agent.prompt` (brief montado por `buildDelegationBrief` + follow-ups do
  `holistic_send`). O transcript completo do pai **não** é enviado por padrão
  (contrato de delegação).
- **Mensagens filho → pai**: o filho executa
  `herdr pane run "$HOLISTIC_PARENT_PANE_ID" "[MARKER] delegation=… pane=… token=…"`;
  o texto do callback é parseado (`parseCallback`) e autenticado
  (`timingSafeEqual` sobre o `HOLISTIC_CALLBACK_TOKEN`), além da checagem de
  ownership do pane. Markers: `HOLISTIC_QUESTION`, `HOLISTIC_INPUT_REQUIRED`,
  `HOLISTIC_HANDOFF_READY`.
- **Estado durável**: `AgentSession` e `DelegationRun` vivem como entries
  estruturadas no branch da sessão Pi (repository), com máquina de estados
  (`prepared → starting → working → awaiting_input → ready_for_review →
  correcting → working → accepted/failed/cancelled`), `questions[]`,
  `evidence[]` e uma
  `Session Mutation Sequence` monotônica. **Snapshot histórico da pesquisa,
  acessado em 2026-08-02:** `paneOutput` era apenas diagnóstico (snapshot das
  últimas 240 linhas via `pane.read`). Esse mecanismo foi removido em
  `17464b13`; a versão atual não usa `pane.read` como transcript/fallback.
- **Artifacts**: Runs novas usam manifests JSON versionados. O
  `ArtifactStore` cria roots privados temporários sob `os.tmpdir()` com
  `mkdtemp`, publica com temp-file + rename atômico e valida containment,
  symlinks, ownership, permissões, tamanho, media type e SHA-256. O callback
  carrega somente a identidade e o hash do manifest; `holistic_inspect` lê e
  valida o manifest e os artifacts. **Snapshot histórico:** “Runs legadas” e o
  fallback do pane descreviam o fallback v1 antes de `17464b13`; v1 foi
  removido e não há fallback por transcript no contrato atual.

---

## 3. Achados por sistema

### 3.1 Anthropic Claude Code — subagents (dentro da sessão)

Fonte: https://code.claude.com/docs/en/sub-agents

- Subagent = worker delegado dentro de **uma** sessão, com context window
  próprio, system prompt custom e tools restritas: "the subagent does that work
  in its own context and returns only the summary" (docs, "Create custom
  subagents", seção de abertura).
- A comunicação é **prompt in, summary out**: o pai escreve o prompt de
  invocação; o subagent devolve um resumo; não há transcript compartilhado.
- Subagents **não falam entre si**: "Subagents only report results back to the
  main agent and never talk to each other" (docs, "Compare with subagents",
  tabela Subagents × Agent teams).
- A doc de agent teams reforça: subagents "can only report back to the main
  agent" (https://code.claude.com/docs/en/agent-teams — "When to use agent
  teams").

### 3.2 Anthropic Claude Code — agent teams (sessões independentes)

Fonte: https://code.claude.com/docs/en/agent-teams

- Cada teammate é uma **instância Claude Code completa** com context próprio; o
  histórico do lead "does not carry over". Comunicação entre teammates é por
  mensagens diretas (`SendMessage`), task list compartilhada e mailbox.
- **Mailbox**: a documentação atual (verificada em 2026-08-02, seção
  "Architecture") afirma literalmente que cada mailbox é um arquivo JSON:

  > "Each agent's mailbox is a JSON file at
  > `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`. Claude Code
  > validates every entry when it reads a mailbox file. Entries that don't
  > match the message format are reported as errors and removed from the
  > file; the valid messages are still delivered."

  A mesma página registra que, antes de v2.1.207, uma entrada malformada
  bloqueava a entrega daquele mailbox até a remoção manual do arquivo, e que a
  entrega é automática ("messages are delivered automatically… The lead
  doesn't need to poll for updates") — o mecanismo de observação do mailbox
  (watch/poll/socket) **não é descrito na página**.
- **Task list compartilhada e config são locais, em arquivos** (seção
  "Architecture"): task list em `~/.claude/tasks/{team-name}/` (estados
  pending/in progress/completed, dependências entre tasks) e config em
  `~/.claude/teams/{team-name}/config.json` (session IDs, pane IDs; membros
  podem ler o config para descobrir outros agentes). O config é removido no
  fim da sessão; a task list **persiste** localmente e sobrevive a sessões
  retomadas; a retenção é governada por `cleanupPeriodDays` ("Retention is
  governed by the same `cleanupPeriodDays` you already control for session
  transcripts").
- **Claim de task usa file locking** (seção "Assign and claim tasks"):
  "Task claiming uses file locking to prevent race conditions when multiple
  teammates try to claim the same task simultaneously."
- Leitura factual: a doc atual da Anthropic descreve o barramento entre
  sessões como **arquivos locais (mailboxes JSON + task list)** com validação
  de formato na leitura, locking para claims e política de retenção — e a
  conclusão "mailbox é file-based" repousa na citação literal acima.

### 3.3 Anthropic Claude Code — artifacts

Fonte: https://code.claude.com/docs/en/artifacts

- Artifact = página web interativa publicada em claude.ai a partir de um
  arquivo HTML/Markdown do projeto; limite de 16 MiB por página; versions;
  sharing. É um canal de output para humanos, não um barramento agent-to-agent.
- Relevante como *pattern*: o conteúdo vive em **arquivo** e a mensagem carrega
  apenas o caminho/URL; "Claude writes the page to an HTML or Markdown file in
  your project, then publishes it".

### 3.4 OpenAI — Agents SDK (handoffs, sessions, estado)

Fontes:
- https://openai.github.io/openai-agents-python/handoffs/
- https://openai.github.io/openai-agents-python/sessions/
- https://openai.github.io/openai-agents-python/running_agents/

- **Handoffs são tools**: delegar = chamar `transfer_to_<agent>`; o runtime
  passa o controle e **transfere a conversa junto** ("transfers the latest
  conversation state", docs "Handoffs", seção "Recommended prompts"; a
  "practical guide" da OpenAI descreve o mesmo). Metadata pequena
  (`reason`, `language`, `priority`, `summary`) vai por `input_type` do
  handoff — não por arquivo.
- **Estado conversacional, 4 estratégias** (docs "Running agents", tabela
  "Choose a memory strategy"): `to_input_list()` (memória do app),
  `session` (storage do cliente + SDK, ex. `SQLiteSession`),
  `conversation_id` (OpenAI Conversations API, server-side, compartilhável
  entre workers) e `previous_response_id` (Responses API). Nenhuma usa
  filesystem compartilhado; estado é DB ou API do provider.
- Limitação documentada: `Session` não pode ser combinada com
  `conversation_id`/`previous_response_id`/`auto_previous_response_id` na
  mesma run (docs "Sessions", seção de abertura) — o app escolhe um
  mecanismo de estado por vez.

### 3.5 OpenAI — Codex (harness/loop)

Fonte: https://openai.com/index/unrolling-the-codex-agent-loop/ (post de
engenharia da OpenAI, M. Bolin, 2026-01-23)

- O harness roda o agent loop sobre a Responses API; o contexto inicial é
  montado a partir de **arquivos de instrução** (`AGENTS.md`,
  `AGENTS.override.md` em `$CODEX_HOME` e na árvore do projeto, limite padrão
  de 32 KiB), somados a um bloco `role=developer` que descreve o sandbox do
  tool `shell`.
- Sandbox é por ferramenta de shell (permissões de arquivo/rede); tools MCP não
  são sandboxed pelo Codex. O artigo não descreve subagentes/transporte
  entre agentes; é citado aqui pelo padrão **contexto via arquivos** e pelo
  sandbox baseado em filesystem.

### 3.6 Google — A2A Protocol v0.3.0 (spec oficial)

Fonte: https://a2a-protocol.org/v0.3.0/specification/

- Modelo de dados explícito: **Message** (turno com `role` e `Parts`),
  **Task** (unidade stateful com lifecycle: `submitted`, `working`,
  `input-required`, `completed`, `canceled`, `failed`, `rejected`,
  `auth-required`; estados terminais não reiniciam), **Part** (TextPart,
  FilePart, DataPart) e **Artifact** (output do agente composto de Parts).
- Separação estado × mensagem × artifact: "Tasks in completed state SHOULD use
  artifacts for returning the generated output to the clients" (spec, §6.1).
  O `history` do Task guarda as mensagens trocadas.
- **Arquivos grandes = URI, não bytes na mensagem**: `FilePart` aceita
  `FileWithBytes` (base64, "if files are small") ou `FileWithUri` ("If the file
  is large, the agent should read the content as appropriate directly from the
  file_with_uri source", §6.5.2/§6.6; exemplo de file exchange §9.6).
- Transport: JSON-RPC 2.0 sobre HTTP(S) (mandatório), gRPC e HTTP+JSON
  opcionais; streaming via SSE; push notifications via webhook com token por
  task (§6.8) — mesmo padrão de callback autenticado usado pelo holistic.
- O cliente **não acessa estado interno do agente**: a spec declara que o
  objetivo é interoperar "without needing access to each other's internal
  state, memory, or tools" (§1). Estado é exposto só através do `Task`.

### 3.7 Microsoft — AutoGen

Fontes:
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/group-chat.html
- https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.teams.html

- Core API: agentes são event-driven e se comunicam por **pub/sub tipado sobre
  tópicos** (`GroupChatMessage`, `RequestToSpeak`, `SingleThreadedAgentRuntime`),
  não por arquivos.
- Estado: teams expõem `save_state()`/`load_state()` (serialização JSON do
  estado de todos os participantes); a doc alerta para chamar `save_state`
  apenas com o time parado.
- Padrão dominante: mensagens = objetos tipados em memória/event bus; estado =
  serialização explícita do runtime.

### 3.8 LangChain — LangGraph

Fontes:
- https://docs.langchain.com/oss/python/langgraph/persistence
- https://langchain-ai.github.io/langgraph/concepts/breakpoints/ (interrupts)

- Persistência em duas camadas: **checkpointers** = memória de curto prazo
  (snapshot do graph state a cada super-step, organizado por thread; permite
  restart do último passo bom e resume); **stores** = memória de longo prazo
  cross-thread.
- Backends: SQLite/Postgres/Redis/in-memory; **não é filesystem compartilhado
  ad-hoc** — checkpoints são um armazenamento estruturado (docs "Persistence").
- `interrupt()` salva o estado e pausa até input externo — equivalente
  estrutural do `awaiting_input` do holistic, mas persistido no checkpointer.
- Subgraphs herdam o checkpointer do pai por padrão (how-to "Manage
  conversation history").

### 3.9 Fontes primárias sobre `/tmp` e arquivos temporários

Fontes:
- FHS §3.18: https://specifications.freedesktop.org/fhs/latest/tmp.html
- systemd-tmpfiles (man oficial):
  https://www.freedesktop.org/software/systemd/man/systemd-tmpfiles.html
- systemd, "Using /tmp/ and /var/tmp/ Safely": https://systemd.io/TEMPORARY_DIRECTORIES/
- Node.js `os.tmpdir()`: https://nodejs.org/api/os.html
- Node.js `fs.mkdtemp()`: https://nodejs.org/api/fs.html
- `mkstemp(3)`: https://man7.org/linux/man-pages/man3/mkstemp.3.html

- **FHS §3.18**: `/tmp` é "made available for programs that require temporary
  files"; "Programs must not assume that any files or directories in `/tmp`
  are preserved between invocations of the program"; e, embora a limpeza seja
  site-specific, "it is recommended that files and directories located in
  `/tmp` be deleted whenever the system is booted".
- **systemd-tmpfiles**: o man oficial descreve que o comando "creates,
  deletes, and cleans up volatile and temporary files and directories" e que
  `--clean` remove "all files and directories with an age parameter
  configured". O guia systemd "Using /tmp/ and /var/tmp/ Safely" afirma:
  "By default, `systemd-tmpfiles` will apply a concept of 'ageing' to all
  files and directories stored in `/tmp/` and `/var/tmp/`" — ou seja, em
  sistemas systemd `/tmp` tem limpeza automática por idade, fora do controle
  do aplicativo.
- **Node.js**: `os.tmpdir()` "Returns the operating system's default directory
  for temporary files" (honra `TMPDIR`/`TEMP`/`TMP`); `fs.mkdtemp()` "Creates
  a unique temporary directory" anexando caracteres aleatórios ao prefixo — o
  caminho resultante não é previsível.
- **`mkstemp(3)`**: "The file is created with permissions 0600… The file is
  opened with the open(2) O_EXCL flag, guaranteeing that the caller is the
  process that creates the file" — o padrão POSIX para criar temporários com
  segurança contra colisão e symlink races (a página registra que o glibc
  antigo usava 0666 e que POSIX.1-2008 passou a exigir 0600).

---

## 4. Comparação explícita: messages × state × artifacts

| Dimensão | Mensagens conversacionais | Estado durável | Artifacts grandes |
|---|---|---|---|
| Tamanho típico | Pequeno (KB); entra no context do LLM | Estruturado, consultável | Grande (MB+); não entra no context |
| Transporte preferido nas fontes | Canal de mensagens: tool call (`transfer_to_*`), `message/send`, `SendMessage`, `agent.prompt` | Store/checkpoint/DB: LangGraph checkpointer, OpenAI `Session`/`conversation_id`, A2A `Task`, task list JSON (Claude teams), entries da sessão Pi | Arquivo + referência: A2A `FilePart` URI, worktree/arquivos do projeto, artifacts publicados |
| Frequência | Alta (turnos) | Gravação por transição | Baixa (entrega final / evidência) |
| Consistência/concorrência | Ordem de entrega; fila por sessão | Transações/checkpoints; **file locking** no caso de arquivos (Claude teams) | Imutáveis ou versionados (Claude artifacts têm versions) |
| Retenção | Transcript da sessão | Sobrevive a restarts | Sobrevive conforme política (Claude teams: `cleanupPeriodDays`; artifacts: retention policy) |
| Quem lê | O LLM do destinatário | O runtime/coordenador | O destinatário sob demanda (URI) |
| Exemplo de falha documentada | Entradas malformadas no mailbox bloqueiam entrega (Claude teams, antes de v2.1.207) | Estado inconsistente se salvo durante run (AutoGen `save_state`); `Session` não combina com `conversation_id`/`previous_response_id` (OpenAI Sessions docs) | 16 MiB por artifact (Claude); FilePart do A2A: URI recomendada para arquivos grandes |

Ponto de consenso entre as fontes: **mensagens e artifacts não são a mesma
coisa**. Mensagens carregam conteúdo pequeno ou *referências*; artifacts são
outputs grandes referenciados por URI/caminho (A2A explícito; Claude Code
idêntico com "send a teammate a link instead of pasting output"). Estado
durável, quando sobrevive a restarts, vive em store estruturado (DB/checkpoint)
ou em arquivos **com locking, validação e limpeza** (único caso file-based de
peso nas fontes: Claude agent teams).

---

## 5. Análise factual da proposta "todas as interações via arquivos em /tmp"

Achados factuais que qualquer decisão deve considerar:

1. **Há precedente oficial de mensageria file-based**: os agent teams da
   Anthropic transportam mensagens entre agentes em mailboxes que a doc atual
   descreve literalmente como arquivos JSON, e coordenam trabalho por task
   list em arquivos com file locking. (3.2)
2. **Mas esse precedente é file-based com disciplina**: validação de formato
   na leitura, locking para claim, diretórios namespaced por team, config
   efêmero vs task list durável com retenção por `cleanupPeriodDays`. Arquivos
   soltos em `/tmp` sem esses mecanismos não equivalem ao padrão. (3.2)
3. **`/tmp` não garante durabilidade nem namespacing**: o FHS diz que
   programas "must not assume that any files or directories in `/tmp` are
   preserved between invocations" e recomenda deletar o conteúdo no boot; em
   sistemas systemd, `systemd-tmpfiles` aplica "ageing" por padrão a `/tmp` e
   `/var/tmp` (limpeza por idade, fora do controle do aplicativo). (3.9)
4. **O padrão para temporários é criação segura e não previsível**: `mkstemp`
   cria com 0600 + O_EXCL; Node oferece `os.tmpdir()` + `fs.mkdtemp()`
   (diretório único por invocação). Caminho previsível não é o que as APIs
   nativas recomendam. (3.9)
5. **Nenhuma fonte primária usa `/tmp` como barramento universal**: os
   sistemas com estado durável usam DB/checkpoint/API (LangGraph, OpenAI, A2A
   Task server-side). (3.4, 3.6, 3.8)
6. **Arquivos grandes já têm o padrão "referência na mensagem"**: A2A manda
   bytes inline só para arquivos pequenos e URI para grandes; Claude artifacts
   publicam de arquivo local. Mensagens ficam pequenas; arquivos ficam no
   filesystem. (3.3, 3.6)
7. **Mensagens curtas carregadas no pane/transcript têm função de contexto**:
   subagents Claude recebem prompt e devolvem resumo; o Agents SDK transfere a
   conversa junto no handoff. Mover turnos conversacionais para arquivo
   obrigaria o destinatário a ler/poll arquivo + manter o conteúdo no context
   de qualquer forma. (3.1, 3.4)
8. **Um arquivo, sozinho, não desperta ninguém**: os despertadores
   documentados nas fontes são canais ativos — A2A usa SSE e push
   notifications via webhook com token; LangGraph usa `interrupt()` +
   checkpointer; o holistic usa callback via `herdr pane run` sobre o socket;
   os agent teams da Anthropic afirmam entrega automática "without polling"
   sem descrever o mecanismo de observação do mailbox. Filesystem é passivo:
   sem socket/event/watch/poll, escrever um arquivo não acorda o pai. (2, 3.2,
   3.6, 3.8)
9. **No holistic, parte do "file-like" é estruturada**: na v1 o pai lia
   diagnóstico via `pane.read` (snapshot truncado de texto); isso foi removido
   em `17464b13` — hoje as Runs publicam artifacts em roots registrados e os
   referenciam por `ArtifactRef`, sem fallback por transcript; arquivos
   duráveis continuam no `cwd`/worktree da delegação e são auditados por
   caminho relativo e baseline Git.

---

## 6. Recomendação para este projeto (opinião, separada dos fatos acima)

> Esta seção é a recomendação específica do holistic-subagents; os achados
> factuais estão nas seções 1–5.

**Não mover todas as interações para `/tmp`.** O padrão das fontes primárias e
a arquitetura atual convergem para um desenho híbrido, já implementado:

1. **Control plane e estado durável ficam onde estão**: Herdr socket para
   lifecycle e entries da sessão Pi para o estado da delegação. Estado que
   precisa sobreviver a restarts nunca deve morar em `/tmp`.
2. **Mensagens conversacionais continuam por `agent.prompt` + callbacks**:
   são pequenas, precisam entrar no context do LLM do destinatário e já têm
   autenticação (token) e máquina de estados. Trocar isso por arquivos
   adicionaria polling/locking sem ganho.
3. **Artifacts grandes: `/tmp` é o data plane de artifacts descartáveis**:
   quando a evidência for volumosa (logs longos, diffs, outputs de
   ferramentas), o filho grava no root temporário autorizado e o
   `HANDOFF_READY` carrega só a **referência** (ID + tamanho + hash + media
   type). Na v1 a evidência dependia do `pane.read` truncado (240 linhas); v1
   foi removida em `17464b13` e o contrato atual não tem fallback por
   transcript. O limite padrão é 8 MiB por artifact e 64 MiB por root.
4. **Criação dos temporários com as APIs nativas, sem caminho previsível**:
   `os.tmpdir()` + `fs.mkdtemp()` por Session (diretório único e não
   previsível, modo 0700), arquivos 0600, escrita via temp + rename atômico e
   cleanup do diretório no `cleanup` da delegação. **Não** usar um diretório
   fixo tipo `${TMPDIR}/holistic-<id>` — caminho previsível é anti-padrão
   (`mkstemp`: 0600 + O_EXCL; `mkdtemp`: sufixo aleatório).
5. **A referência não substitui o despertar**: o pai só lê o artifact quando
   for notificado — pelo callback já existente (`HOLISTIC_HANDOFF_READY`/
   `HOLISTIC_QUESTION` via socket). Nada de esperar o pai "ver" o arquivo:
   filesystem é passivo; sem socket/event/watch/poll o pai não acorda.
6. **Se um dia houver troca direta filho↔filho** (hoje não há: o contrato é
   pai↔filho), o modelo a copiar é o dos agent teams da Anthropic: diretório
   namespaced por delegação, arquivos JSON validados, locking para claims e
   limpeza no cleanup — não arquivos soltos.
7. **Resumo de escopo**: `/tmp` = data plane de artifacts descartáveis. Não é
   control plane (lifecycle fica no Herdr socket), não é message bus universal
   (mensagens ficam no `agent.prompt` + callbacks), não é estado durável
   (estado fica nas entries da sessão Pi; `/tmp` não sobrevive a boot/aging
   — FHS e systemd-tmpfiles). Preferir o worktree/`cwd` da delegação quando o
   artifact precisar sobreviver à sessão.

**Risco/incerteza remanescente**: a robustez do root local depende de pai e
filho compartilharem host/filesystem, hoje garantido pelas panes locais; o
desenho precisará mudar se topologias remotas aparecerem. O protocolo atual
usa IDs opacos de artifacts, não URIs remotas.
