# Plano completo — pi-repl-notebook

## 1. Escopo e estado desta entrega

Este documento é o plano de implementação, conforme o pedido mais recente. A implementação foi iniciada pelo pedido original, mas **não está concluída nem aprovada para uso em produção**. Os arquivos parciais existentes devem ser aproveitados somente depois dos testes previstos abaixo.

Princípio do produto:

- **Tool direta:** operação simples ou interação pertencente ao Pi.
- **Code Mode:** composição autocontida, com runtime descartável.
- **Notebook Mode:** composição persistente, com bindings e estado próprios.

Não haverá troca de provider, adapter de modelo, substituição das tools existentes, shell paralelo, RLM, subagents, scheduler, daemon ou execução autônoma como funcionalidades da extensão.

### Evidências já obtidas

| Item | Evidência | Estado |
|---|---|---|
| Referência Igor | `main`, commit `7021ae48e8efe36a3becc5830d529696ff798e5e` | Investigada; mapa em `reference-map.md` |
| Referência Prime | `main`, commit `9c54a35dac3a2ad17910074d66664859ea175666` | Investigada; runtime atual, não somente documentação histórica |
| Pi | Documentação/API instalada 0.85.1 | `getAllTools()` retorna metadata; não fornece executor público genérico com middleware |
| Deno | 2.9.6, Linux x86_64 | Instalado; nenhum download de runtime realizado |
| Jupyter | Probe real informou protocolo 5.3 e Deno 2.9.6 | Startup, execução TS simples e shutdown observados |
| Heap V8 | Probe com `DENO_V8_FLAGS` | Limite configurável observado; não equivale a limite de RSS/process tree |
| Persistência isolada | `tests/persistence.test.ts` | 8 testes aprovados, conforme execução do responsável pelo módulo |
| Typecheck global | `npm run typecheck` | Falha em `src/execution/engine.ts`: `number` versus `Timeout` |
| Integração completa | Sem suíte ponta a ponta concluída | Não validada |
| Plataformas | Somente máquina Linux usada até aqui | macOS e Windows não validados |

Os módulos parciais cobrem contratos, kernel Jupyter, bridge, execução, Code Mode, Notebook e persistência. Existência de arquivo não demonstra cumprimento de requisito. `src/index.ts`, o schema/roteador da tool pública, seus testes e o exemplo cooperativo ainda não foram criados. Os testes de bridge e de integração do kernel também ainda não foram criados.

## 2. Decisões arquiteturais

### 2.1 Backend inicial: Deno Jupyter

Usar `KernelBackend` com um adapter `JupyterKernelBackend`, ZeroMQ e Jupyter Wire. Não incluir servidor Jupyter, Python, ipykernel ou ambiente Prime como dependências de execução.

Justificativa:

1. Deno fornece implementação nativa de REPL TypeScript, imports e top-level await.
2. Um protocolo próprio não resolve sozinho bindings lexicais, closures, redeclarações ou interrupção.
3. Não existe evidência de que um REPL customizado local passe a suíte exigida.
4. A dependência ZeroMQ é aceitável diante da prioridade de correção semântica.

Um backend customizado só poderá substituir esse adapter após passar **a mesma suíte integral**, incluindo background, interrupção e tracebacks. Não criar um segundo backend de produção apenas para reduzir dependências.

**Gate imediato:** corrigir a barreira de startup IOPub. Um probe perdeu o primeiro `console.log` quando executado imediatamente após o handshake shell. Um atraso de 500 ms fez o output aparecer, mas **delay fixo não é solução**. A disponibilidade exige confirmação real de assinatura/recepção IOPub e canais prontos.

### 2.2 Isolamento dos modos

| Propriedade | Code Mode | Notebook Mode |
|---|---|---|
| Processo | Novo kernel por execução | Kernel por sessão Notebook |
| Bindings | Descartados ao concluir | Reutilizados entre cells |
| Concorrência | Até quatro kernels, limite configurável | Uma operação mutante por sessão; rejeição explícita de conflito |
| Resultado | Retorno estruturado e rich output | Outputs da cell e estado live |
| Checkpoint automático | Nunca | Após execução consistente e finalização dos recursos pertencentes à cell |
| Journal persistente | Excluído | Incluído |
| Projeto/profiles/pins | Sem acesso implícito | Operações explícitas |
| Falha | Cleanup da execução; Notebook intacto | Geração morta/suja; recuperação pelo último checkpoint válido |

Não compartilhar kernel, module cache live, identidade, geração ou bindings entre os modos. Compartilhar apenas infraestrutura do host, contratos, políticas, conversão de resultados e mecanismos de lifecycle.

A primeira versão não terá pool de kernels. Isso evita vazamento de estado e cleanup incompleto disfarçados de otimização.

Identidade inicial: um Notebook por sessão Pi. Sessões Pi concorrentes possuem Notebooks privados, mesmo no mesmo projeto. Seleção arbitrária de Notebook por ID vindo do modelo não é necessária para esse isolamento e não será habilitada sem autorização/contexto do host.

### 2.3 Concorrência do Notebook

Uma sessão aceita apenas uma operação que possa executar ou alterar o kernel. Execução, snapshot, checkpoint, restore, profile load, prune, reset e restart passam pela mesma exclusão mútua.

- `status`, consulta de execução e leitura de metadata não exigem o kernel.
- `interrupt` e `terminate` não entram na fila bloqueada por uma cell.
- Startup concorrente compartilha uma promise por geração.
- Requisições concorrentes incompatíveis retornam `NOTEBOOK_BUSY`, sem filas ilimitadas.
- Cada sessão privada tem sua própria exclusão; o lock de disco protege somente transações compartilhadas.

## 3. Módulos e responsabilidades

A organização poderá consolidar arquivos pequenos, sem eliminar estas responsabilidades:

| Módulo | Responsabilidade | Não deve conhecer |
|---|---|---|
| `extension` / `index` | Registro, lifecycle do Pi, configuração e contexto da sessão | Frames ZeroMQ, serialização de bindings |
| `tool` | Schema, validação discriminada, roteamento e conversão para resultado Pi | Processos e locks |
| `execution` | IDs, registros, transições, wait/yield, deadlines e retenção | Estado de projeto e detalhes de provider |
| `code-mode` | Execução autocontida e finalização de recursos efêmeros | Profiles e bindings Notebook |
| `notebook-mode` | Cells, consistência, metadata de bindings e operações persistentes | Transporte específico do kernel |
| `kernel` | Interface comum, adapter Deno, interrupção, inspeção e eventos | ToolDefinition e aprovação |
| `bridge` | Descoberta, capacidades, preflight, invocação e contexto aninhado | Reimplementação das tools |
| `persistence` | Formatos, validação, escrita atômica, CAS, locks e budgets | Execução de código histórico |
| `profiles` e `journal` | Operações restauráveis e histórico/exportação | Estado live de outros modos |
| `runtime` | Binário Deno, integridade, processos próprios e containment | Shell do usuário |
| `diagnostics` | Diagnóstico bounded de sintaxe, runtime e persistência | Servidor residente desnecessário |

`profiles` e `journal` podem começar dentro do módulo de persistência. Separar em arquivos apenas quando isso reduzir acoplamento real.

### Interfaces internas

Consolidar os contratos já iniciados:

- `ReplExecutionEngine`: execute, interrupt, terminate, diagnostics e shutdown.
- `KernelBackend`: start, execute, interrupt, inspect, snapshot/restore ou operações internas equivalentes, diagnostics e shutdown.
- `NotebookRuntime`: engine mais bindings, snapshot, checkpoint, restore e reset.
- `ToolProvider`: metadata, resolução da definição real, capacidades, preflight e invoke.
- `StateStore`: transações de sessão/projeto, profiles e journal.

O contrato atual de `KernelBackend` ainda é parcial: inspeção e operações de estado não devem ficar permanentemente acopladas a strings Jupyter no host Notebook. Encapsular esse conhecimento no adapter de runtime sem recriar a semântica de execução.

## 4. Interface model-facing

Registrar **uma única tool**, nome proposto `repl_notebook`. Não registrar `exec`, `wait`, `interrupt`, `notebook` ou `code_mode` adicionais.

Usar um objeto TypeBox com enums compatíveis com o Pi e validação discriminada em runtime. Isso evita exigir suporte do provider a uma união complexa no topo do schema. Os discriminantes permanecem explícitos.

### Requisições

| `mode` | `action` | Campos específicos |
|---|---|---|
| code/notebook | `exec` | `code`, `yield_time_ms?` |
| code/notebook | `wait` | `execution_id`, `yield_time_ms?`, `cursor?` |
| code/notebook | `interrupt` / `terminate` | `execution_id` |
| code/notebook | `status` / `diagnostics` | `execution_id?` |
| notebook | `bindings` / `snapshot` / `checkpoint` / `restart` | Nenhum |
| notebook | `reset` | `scope: "session"` |
| notebook | `pin` / `unpin` | `names` |
| notebook | `release` / `prune` | `names`, `scope: "bindings"` |
| notebook | `profile` | `operation: save/list/load`, `name` quando aplicável |
| notebook | `project` | `operation: status/promote/rollback`, geração esperada; geração-alvo no rollback |
| notebook | `journal` | `operation: list/export`, paginação quando aplicável |
| code/notebook | `tools` | Consulta de definições/capacidades autorizadas no modo |

Rejeitar ações Notebook em Code Mode, campos incompatíveis, IDs de outro modo/sessão, nomes inválidos e operações destrutivas sem escopo. A primeira versão exige `mode`; não inferir persistência a partir do código.

### Respostas

Retornar identificação de execução, modo, cell quando aplicável, geração, estado, status de cleanup, outputs bounded, resultado estruturado quando houver, erro tipado e cursor de acompanhamento.

- `yielded` informa execução aceita e ainda ativa, não falha.
- `wait` repetido é idempotente; cursor evita reenviar outputs já consumidos.
- Execução expirada retorna erro distinto de execução inexistente.
- Resultados grandes devem ser truncados ou materializados em artefato limitado, com indicação explícita.
- Falhas de validação/política usam erro Pi; falhas assíncronas preservam o registro consultável e são apresentadas como falha, não como texto de sucesso.

## 5. Semântica de código

### Notebook

Enviar source TypeScript ao REPL nativo sem `eval`, sem substituir `const` por `var`, sem reescrever declarações e sem envolver toda cell em função.

Verificar na versão fixada: escopo lexical, TDZ, mutação, redeclarações, imports, funções, classes, closures, destructuring, top-level await e comportamento depois de exceções.

O parser TypeScript pode **descobrir metadata**, nunca simular a execução. A descoberta precisa considerar imports, aliases, declarações e identificadores Unicode. Namespaces/enums e bindings dinâmicos exigem classificação explícita; nomes não descobertos não podem desaparecer silenciosamente do manifest.

### Code Mode

Contrato: corpo assíncrono autocontido com `return`, compilado/executado pelo Deno em módulo temporário privado. Imports estáticos ficam no escopo do módulo; declarações do usuário ficam no corpo da operação.

A extração de imports usa parser TypeScript, não regex. Ela só será mantida se testes demonstrarem correção para comentários, imports de tipo, aliases, erros, line mapping e resolução relativa. Alternativa interna: geração por AST com source maps. Não alterar a semântica de bindings para facilitar o wrapper.

**Resolver antes de liberar:** um módulo criado no diretório temporário muda a base de imports relativos. A base semântica deve ser o `cwd` do projeto. Usar resolução de módulo apropriada ou artefato de execução cuja URL/base seja explicitamente controlada. Não ignorar esse desvio.

Cada execução limpa módulo, arquivos auxiliares, kernel e subprocessos pertencentes à execução. Imports e retornos estruturados não devem depender de uma execução anterior.

## 6. Bridge e autoridade do host

### Limitação real da API atual

`pi.getAllTools()` e `pi.getActiveTools()` permitem descobrir metadata e atividade. Não fornecem acesso público universal à invocação real com `tool_call`, `tool_result`, aprovação e renderização.

Portanto:

1. Criar `ToolProvider` cooperativo usando APIs públicas/event bus do Pi.
2. O host entrega definições reais e implementa preflight/invoke com sua política.
3. Sem provider integrado, computação local continua possível, mas `tools.*` fica indisponível e a limitação aparece em status/diagnostics.
4. **Não** reconstruir built-ins nem chamar um `execute` bruto alegando equivalência ao pipeline completo do Pi.
5. Para acesso transparente a todas as tools já instaladas, será necessária uma API oficial de nested invocation no Pi ou integração explícita do host. Esse é um limite de plataforma, não algo solucionável por metadata.

O aceite deve distinguir integração cooperativa suportada de acesso universal inexistente. Enquanto este último não existir, não anunciar acesso irrestrito às tools reais já instaladas.

### Políticas por capacidade

Cada definição autorizada possui classificação explícita:

- modo permitido;
- nested permitido;
- aprovação necessária;
- interação, foreground ou output interativo;
- cancelamento suportado;
- paralelismo, exclusividade e reentrada;
- contexto de sessão necessário;
- background permitido.

Defaults conservadores: negar tools não classificadas, interativas, recursivas ou sem suporte contratual de cancelamento. A identidade da própria extensão é proibida no bridge para evitar recursão.

### Caminho de uma chamada

1. Validar protocolo, autenticação, tamanho e identidade.
2. Resolver definição/atividade/capacidade **atuais**.
3. Aplicar preparação de argumentos quando definida e validar o schema.
4. Criar nested tool call ID e contexto com cwd, sessão, modo, geração, execução, cell, signal e updates.
5. Executar preflight/aprovação no host.
6. Revalidar disponibilidade/geração/schema se houve mudança durante aprovação.
7. Invocar a implementação real pelo provider autorizado.
8. Preservar resultado, erro e updates; converter somente na fronteira de apresentação.
9. Drenar ou cancelar recursos pendentes conforme o contrato.

Não achatar automaticamente `ToolResult.content` em arrays/strings: `tools.*` retorna o resultado original. Um helper de conversão explícito poderá existir se necessário, sem heurística silenciosa.

### Cancelamento de tools não cooperativas

O host Pi executa extensões no próprio processo. Não é possível matar uma promise arbitrária sem arriscar o Pi. Por isso, o contrato do provider exige cooperação real com `AbortSignal`.

Quando esse contrato falhar: marcar cleanup pendente, bloquear novas chamadas daquele contexto, expor diagnóstico e não afirmar ausência de trabalho órfão. Avaliar quarentena da capacidade/provider. Nunca encerrar o Pi para limpar uma nested tool.

## 7. Protocolo, identidade e atribuição

### Dois protocolos, responsabilidades diferentes

- Kernel: Jupyter Wire 5.x, versão negociada, frames autenticados e canais separados.
- Bridge host/runtime: protocolo próprio com `PROTOCOL_VERSION = 1`, handshake obrigatório e mensagens JSON bounded sobre HTTP loopback autenticado.

Não tentar interpretar frames incompatíveis. Stdout/stderr do processo não são canal de controle.

Envelope normalizado interno: versão, request ID, session ID, mode, execution ID, cell ID opcional, generation, tipo, sequência e timestamp. Credenciais locais não aparecem em journal, prompt ou diagnostics.

Eventos normalizados:

- disponibilidade/handshake;
- início, yield e conclusão;
- stdout, stderr, rich display e resultado;
- nested tool start/update/result/error;
- notificação e memória;
- snapshot/restore e diagnóstico;
- erro, interrupção e shutdown.

Nem todo evento exige um novo tipo de frame Jupyter. O adapter traduz o backend para esse contrato.

### Output

- Associar a origem pelo ID da requisição/evento, nunca pela variável “cell atual”.
- Conservar associação de gerações anteriores somente para marcar output como stale; nunca anexar ao novo kernel.
- Tarefas tardias preservam origem quando comprovável; caso contrário, `unattributed`.
- Subprocessos externos ou writes nativos sem origem verificável não recebem identidade inventada.
- Manter orçamento separado para output background, attachments e registros de origem.
- Conclusão exige resposta shell e barreira IOPub correspondente; emitir completion somente depois da drenagem bounded.

**Gate de atribuição:** testar timer da cell A emitindo durante a cell B. O `parent_header` do Deno pode não representar a origem assíncrona em todos os caminhos. Validar também o `AsyncLocalStorage` usado pelo bootstrap através de top-level await e timers. Se falhar, usar emissão explícita atribuída ou marcar o fluxo como não atribuído. Não publicar o comportamento parcial como confiável.

Rich output preserva MIME bundles e metadata; texto/JSON/imagens compatíveis são convertidos para conteúdo Pi. Formatos não suportados ficam em details/artefatos limitados, sem execução de HTML. Binários têm MIME, tamanho e encoding explícitos.

## 8. Estados, interrupção e execução longa

### Kernel

`not_started → starting → available ↔ executing`

Interrupção: `executing → interrupting → available` somente após confirmação de término; caso contrário `busy_after_interrupt → dead` depois da grace.

Também representar `restarting`, `closing`, `closed` e `incompatible`. Estado terminal não aceita novas requisições.

### Execução

`created → queued → running ↔ yielded → completed | failed | cancelled | terminated | stale`

Cleanup é eixo separado: `pending → completed`. Uma execução não vira sucesso apenas porque o processo fechou. Diferenciar interrupção solicitada de cancelamento confirmado e término forçado.

### Wait/yield

- `yield_time_ms` é limite da espera da tool, não timeout do trabalho.
- Deadline total pertence à execução e inclui startup e chamadas nested.
- Espera curta inicial; consultas podem aumentar até o teto sem polling interno agressivo.
- Consultas repetidas não iniciam novas execuções nem reiniciam o deadline.
- `terminate` atua fora do caminho bloqueado do kernel.
- Shutdown fecha admissão e resolve/rejeita todos os waiters aceitos.

### Races obrigatórias

Aborto antes de startup, durante startup, durante await, durante CPU síncrona, imediatamente antes de completion, shutdown durante startup, restart após interrupção, resposta de tool após cancelamento e output stale após troca de geração.

Notebook interrompido preserva estado somente quando a consistência for comprovada. Caso contrário, marcar dirty/uncertain e impedir checkpoint automático. Recovery restaura o último commit válido e informa perdas.

## 9. Persistência e transações

### Camadas de estado

1. Live: valores e recursos dentro do kernel.
2. Sessão: bindings conhecidos, pins, cell/execution metadata, revisão e base do projeto.
3. Checkpoint: snapshot validado e confirmado em disco.
4. Projeto: gerações imutáveis e ponteiro de head.
5. Profile: estado restaurável por valor e nome explícito.
6. Journal: histórico de execução, não mecanismo de replay.

Raiz recomendada: storage do usuário, particionado por identidade canônica do projeto; sessões privadas por ID. Paths fornecidos pelo modelo não selecionam diretamente arquivos de estado.

### Snapshot best-effort

Manifest versionado inclui runtime/versão, modo, sessão, geração, timestamp e status por binding. Cada exclusão tem motivo. Um valor excluído não impede salvar os demais.

Codec inicial conservador: valores JSON lossless, com validação de tipos, propriedades, identidade e tamanho. Funções, closures, módulos importados, classes, recursos nativos, sockets, streams e objetos com semântica não representável são excluídos explicitamente.

Pontos obrigatórios ainda pendentes:

- detectar ciclos e aliases dentro de um binding e entre bindings;
- não restaurar objetos compartilhados como cópias independentes silenciosamente;
- registrar/preservar características semânticas da declaração quando relevantes; não transformar `const` em `let` sem evidência de equivalência no REPL;
- não executar getters ou `toJSON` durante inspeção;
- classificar propriedades especiais de forma consistente entre runtime e store;
- verificar versão e validar o valor restaurado antes de publicar a nova geração;
- limitar inspeção para que um binding hostil não bloqueie indefinidamente.

### Checkpoint

- Executar apenas com kernel consistente e sem mutação concorrente conhecida.
- Dirty state não é limpo até `fsync`, rename e commit real.
- Retry bounded para I/O transitório; conflito não é retry cego.
- Sessão usa revisão CAS; projeto usa generation CAS.
- Preservar último checkpoint válido se falhar captura, validação ou escrita.
- Background mutante impede garantia de snapshot consistente: rastrear recursos próprios e declarar limites para tarefas arbitrárias do usuário. Não chamar “consistente” apenas porque a cell retornou.

### Projeto e private forks

Ao iniciar a sessão, copiar a geração-base para um fork privado. Sessões já abertas não absorvem mudanças de outra sessão automaticamente.

Promoção explícita compara geração esperada. Duas sessões em N: A promove para N+1; B recebe conflito. Não usar last-write-wins nem merge automático de objetos arbitrários.

Rollback publica nova geração referenciando valores de uma geração anterior. Não reescrever o histórico.

A atualização projeto+metadata de sessão exige plano de recovery para falha entre os dois commits: registrar transação/intenção ou receipt de promoção. O próximo startup deve reconciliar sem promover novamente nem esconder conflito.

Locks possuem host, PID, token e propriedade verificável. Recuperar automaticamente apenas lock comprovadamente abandonado. Tratar PID reuse, falha durante criação do lock, symlinks, paths canônicos e diferenças de rename/fsync entre sistemas.

### Pins, release e prune

- Pin protege binding de operações de descarte.
- Unpin remove proteção, não remove valor.
- Release retira bindings explicitamente nomeados; rejeita pins.
- Prune calcula candidatos não protegidos dentro de escopo explícito, apresenta dry-run e só aplica conjunto autorizado. Não deve ser mero alias sem semântica própria.

Bindings lexicais não são propriedades deletáveis de `globalThis`. Quando for necessário reconstruir kernel para remover nomes, validar antecipadamente que os bindings retidos são restauráveis. Caso contrário, rejeitar com explicação; não perder closures/classes/pins silenciosamente.

### Profiles

Save por valor, list e load; colisões de nome/profile e bindings são erros explícitos por padrão. Load cria candidato isolado, valida, persiste e só então troca o kernel. Falha deixa live state anterior intacto.

Não reexecutar journal. Não perder bindings live não serializáveis para carregar um profile. Quando a operação não puder ser atômica e fiel, rejeitar e orientar reset/exportação explícitos.

### Journal

Registrar source, cell/execution/session/generation, tempos, status, outputs, erros, chamadas nested e restauração. Logs Code Mode têm retenção separada e não entram no Notebook automaticamente.

Usar orçamento agregado; sem exclusão silenciosa. Primeira versão pode recusar crescimento ao atingir budget e oferecer export/archive explícito. Se houver rotação, informar segmentos/intervalos retidos e nunca apagar um segmento aberto.

Exportar nbformat 4.5 válido; validar com schema/nbformat externo em teste de integração, além de `JSON.parse`. Garantir coerência de execution counts, errors, display_data e MIME bundles.

## 10. Runtime, imports, segurança e containment

**Code Mode e Notebook Mode não são sandbox.** Código pode usar as permissões do processo Deno. O token do bridge protege chamadas de terceiros, não código malicioso dentro do próprio kernel.

### Deno

- Fixar e validar inicialmente Deno 2.9.6.
- Preferir binário local explicitamente configurado/instalado; validar versão com subprocesso bounded.
- Não baixar nem executar binários no carregamento da extensão.
- Se disponibilizado provisionamento assistido: ação administrativa autorizada, matriz OS/arch, URL oficial fixa, SHA-256 conhecido, tamanho limitado, extração segura, instalação atômica e rollback de atualização.
- Nunca buscar checksum e executável arbitrários indicados pelo modelo.

### Imports

`deno jupyter` 2.9.6 não expõe `--cached-only`/`--no-remote` como `deno run`. Não prometer bloqueio de instalação/rede por flags inexistentes.

A autorização de startup deve declarar o nível de permissão do runtime e seu comportamento de imports. Registrar specifiers, versão do runtime, configuração/lockfile e dependências resolvidas quando observáveis. AST preflight ajuda UX/auditoria, mas não é sandbox nem bloqueio de imports dinâmicos indiretos.

Se a política do host exigir isolamento ou impedir qualquer import/rede não autorizado, **não iniciar** um backend que não consegue cumprir essa política. Exigir adapter/containment adequado ou autorização explícita do usuário para o escopo de execução não isolada; não reduzir a política silenciosamente.

### Processos

POSIX: grupo de processos próprio, TERM/grace/KILL, validar ownership e aguardar exit. Windows: process tree cleanup com mecanismo apropriado e testes reais; Job Objects se necessários para garantir containment além de `taskkill /T`.

Nunca aplicar cleanup à árvore inteira do Pi. O bridge usa as tools de shell existentes; a extensão inicia somente kernels e auxiliares próprios.

Também testar crash do host, não só shutdown normal. Processos sobreviventes precisam de mecanismo seguro de parent ownership/watchdog/registro de recuperação. Não matar PIDs reaproveitados. `detached` sem estratégia para morte do pai não satisfaz ausência de órfãos.

## 11. Limites iniciais

Valores iniciais propostos, configuráveis somente pelo host/usuário e validados. Não são evidência de que todos já estejam aplicados.

| Recurso | Limite inicial |
|---|---:|
| Código/requisição | 256 KiB |
| Resposta do bridge | 1 MiB |
| Output por execução | 256 KiB |
| Background agregado | 64 KiB |
| Attachment | 512 KiB |
| Binding serializado | 1 MiB |
| Snapshot | 4 MiB |
| Bindings rastreados | 512 |
| Journal por sessão | 16 MiB |
| Storage por projeto | 64 MiB |
| Startup | 30 s |
| Interrupt grace | 1,5 s |
| Shutdown | 5 s |
| Diagnostics | 5 s |
| Code Mode total | 120 s |
| Cell Notebook total | 300 s |
| Wait individual | 30 s |
| Heap V8 solicitado | 512 MiB |
| Code execuções concorrentes | 4 |
| Notebook execuções concorrentes por sessão | 1 |
| Execuções retidas | 64 |
| Nested calls por execução | 64 |
| Nested calls paralelas | 8 |
| Profundidade nested | 1 |

Adicionar limites de contagem de frames, sockets, tamanho de headers, HTTP body time, fila de requests, origin maps e IDs encerrados. Unificar limites hoje duplicados entre os módulos.

Heap V8 não limita external buffers, RSS ou descendentes. Medir RSS quando suportado e aplicar containment real quando exigido; documentar limites best-effort por plataforma. Ao exceder limite, reportar a condição e preservar o último estado persistido.

## 12. Integração com Pi e administração

- Factory registra apenas definições e handlers; zero processos, bridge, download e kernel.
- `session_start` estabelece metadata/contexto; não inicia Deno.
- `session_shutdown` fecha admissão, cancela/drena, checkpoint quando seguro e limpa recursos.
- Troca de modelo não toca Notebook. Não ler provider/model ID para definir comportamento.
- Troca de sessão fecha o contexto anterior e cria estado privado para a nova sessão.
- `/fork` e `/tree` precisam de regra explícita: snapshots associados à revisão/cell, sem reaplicar estado futuro em ramo antigo. Se não houver snapshot do ponto histórico, iniciar fork privado a partir de base declarada e informar diferença; nunca fingir time travel live.
- `/reload` deve finalizar runtime anterior antes da reabertura lazy.

Comando administrativo único `/repl`: status, enable, disable, restart, checkpoint, reset, execução terminate, profiles, journal/export, políticas, limites, estado persistido e diagnostics. Operações destrutivas usam confirmação do usuário quando apropriado.

Registro: verificar colisão no momento suportado pelo Pi; se `repl_notebook` já existir, desabilitar esta instância com aviso, sem substituir a tool existente. Uma tool chamada `notebook` deve coexistir normalmente. Testar ordem de carregamento e registro dinâmico; não prometer resolução de conflitos futuros que a API não permita interceptar.

Prompt: orientação curta anexada por API oficial, sem substituir system prompt. Explicar os três caminhos, bindings persistentes, descoberta de tools autorizadas, wait e interação fora dos runtimes.

## 13. Etapas de implementação e gates

### A — Investigação e decisões verificáveis

**Feito parcialmente:** refs fixadas, mapa de dependências e limite da API Pi.

Concluir auditoria das arestas reais e notices. Registrar versão do Pi usada nos testes e divergências de versões. Aceite: nenhum componente de execução depende de provider, runtime histórico ou implementação copiada sem notice.

### B — Contratos, protocolo e configuração

Consolidar KernelBackend/engine/provider/result/error; estados e transições; limites únicos; contrato da tool. Corrigir typecheck existente. Criar unit tests de framing, validação, identity e transições antes de alterar lifecycle.

Gate: typecheck, lint e testes desses contratos aprovados, sem processos.

### C — Harness de semântica Deno

Corrigir startup IOPub e criar testes reais do kernel para bindings, TLA, TS, imports, funções, classes, closures, destructuring, redeclarações, exceções e stack traces.

Gate: suíte integral reproduzível com Deno fixado. Não começar otimização/custom REPL antes disso.

### D — Bridge genérico e políticas

Concluir ToolProvider cooperativo, schema/preparation, atualização dinâmica, contexto, aprovação, interação rejeitada, erros, updates, limites e sinais.

Gate: `mock_a`/`mock_b` reais chamados sequencialmente e em paralelo; provider ausente falha fechado; nenhum bypass de aprovação; cancelamento chega à tool.

### E — Code Mode completo

Resolver imports relativos e source maps, retorno estruturado, emissão rich, timeout/yield/wait, cleanup e concorrência por kernels separados. Logs bounded separados.

Gate: todas as execuções autocontidas, segunda execução sem bindings da primeira, falhas não afetam Pi ou Notebook, zero processos/arquivos próprios após cleanup confirmado.

### F — Notebook live e atribuição

Consolidar lifecycle persistente, metadata de bindings, cells, contexto async e output late. Definir background explícito e política para trabalho não rastreável.

Gate: estado preservado entre cells e após Code Mode, output não atribuído nunca associado à cell errada, operações incompatíveis bloqueadas.

### G — Snapshots e checkpoints

Corrigir fidelidade do codec, partial manifests, dirty/uncertain, validação de restore, replay proibido, locks/atomic write/retry e recovery.

Gate: três bindings serializáveis salvos apesar de um excluído; crash preserva commit anterior; falha de restore não publica geração incompleta.

### H — Projeto, profiles, pins e journal

Private forks, promoção CAS, rollback, transação de promotion receipt, profiles com candidato/rollback, distinção release/prune e export ipynb.

Gate: conflito A/B explícito; load com colisão não altera live state; pin protegido; archive/export não destrói histórico; Code Mode não altera projeto.

### I — Integração pública e UX

Tool única, comandos, prompt curto, provider cooperativo documentado, sessões/forks/model switch, fail-soft e lazy startup.

Gate: carregar extensão não cria recursos; tools diretas permanecem idênticas; conflitos não impedem startup; modo sem UI não simula aprovação.

### J — Hardening e distribuição

Interrupt races, stale frames, abort não cooperativo, dead kernel, startup/shutdown concorrentes, memória, cap de buffers, parent death, runtime verification e política de imports.

Gate: falhas injetadas não corrompem estado nem contaminam gerações; recursos têm término ou pendência explicitamente reportada.

### Diagnostics bounded

Implementar diagnóstico por execução/cell com source e geração conhecidos. Para sintaxe/typecheck, usar processo Deno de curta duração sobre artefato temporário, com timeout, output limitado e cleanup. Não iniciar LSP residente por padrão. Erros do REPL continuam a usar traceback nativo; diagnostics adicionais não podem executar novamente código do usuário nem instalar imports sem a política autorizada. Status de memória, recursos pendentes, compatibilidade, locks e último checkpoint devem ser consultáveis sem iniciar kernel novo.

### K — Verificação final e entrega

Rodar build/lint/typecheck/unit/integration e CI Linux/macOS/Windows. Revisar pacote instalado com dependências de produção. Entregar README, arquitetura, protocolo, persistência, bridge, segurança, licenças e matriz de requisitos verificados.

Gate final: todos os critérios originais comprovados ou limitações de plataforma explicitamente resolvidas/aceitas. Não chamar uma lista de limitações de “aceite integral”.

Dependências principais: A → B → C; B → D; C+D → E/F; F → G → H; E+H → I; I → J → K. Tests isolados de persistência podem evoluir em paralelo a C/D, sem antecipar aprovação ponta a ponta.

## 14. Matriz de testes obrigatórios

| Grupo | Casos mínimos |
|---|---|
| Semântica | lexical/TDZ, TS, TLA, static/dynamic imports e base relativa, closures, classes, destructuring, redeclarações, sintaxe, runtime error, stack/source mapping |
| Code Mode | simples, duas tools, paralelo, transformação, retorno JSON, rich output, isolamento entre chamadas, timeout, interrupt, nested failure, cleanup |
| Notebook | persistência entre cells, semântica após falha, cell longa, restart, checkpoint/restore, pins, prune/release, profiles, journal |
| Bridge | args/cwd/context/IDs/signal/updates preservados, preflight deny, UI reject, active changes, schema changes durante preflight, count/depth/parallel caps |
| Cancelamento | antes do start, durante startup, await, CPU loop, nested tool, perto de completion, wait abort, shutdown e restart |
| Output | log/error/text, rich image, output antes de done, timer A durante B, stdout nativo, stale generation, ordem/cursor e budgets |
| Snapshot | três salvos+um excluído; aliases/ciclos/getters/classes/resources; tamanho; versão inválida; manifest parcial; corrupção e restore rollback |
| Projeto | A/B em N, conflito de promoção, fork privado, rollback como nova geração, crash entre head e sessão, locks antigos/ownership |
| Profiles | save/list/load, colisão de profile/binding, falha em candidato, live não serializável retido |
| Journal | source/status/output coerentes, schema nbformat válido, erro e rich bundle, budget/archive, Code Mode excluído |
| Lifecycle | lazy zero recursos, startup singleflight, shutdown durante startup, morto externamente, parent death, cleanup duplicado idempotente |
| Pi | tool direta intacta, apenas uma tool pública, conflito notebook/repl_notebook, modelo trocado sem reset, sessão/reload/fork/tree, sem UI |
| Segurança | versão HMAC/auth inválidos, body/frame cap, paths/symlinks, payload lossy, geração stale, provider ausente, política de imports incompatível |
| Plataformas | Linux/macOS/Windows: signals/process tree, locks/rename, paths/Unicode, Deno/ZeroMQ e pacote production install |

Testes reais devem verificar processos pelo ownership da extensão, não por uma contagem global de todos os processos Deno do usuário. Fixtures têm cleanup em `finally`, deadline externo e diretório isolado.

Comandos-alvo:

```sh
npm run lint
npm run typecheck
npm run build
npm test
npm run test:integration
npm pack --dry-run
```

Usar checks direcionados durante o desenvolvimento. A suíte completa é gate de integração/release, não repetição após cada edição.

## 15. Pendências concretas da implementação parcial

Estado atual (verificado nesta máquina Linux; macOS/Windows ainda pendentes):

1. ✅ Typecheck `number`/`Timeout` em `execution/engine.ts` corrigido; `npm run typecheck` passa.
2. ✅ Barreira IOPub real (`#proveIopubReady`) substituiu o delay fixo; 4 runs de integração estáveis.
3. ✅ Suíte de semântica do kernel criada (`tests/wire.test.ts`, `tests/kernel.integration.ts`): bindings, TLA, TS, classes, closures, destructuring, reassign `let`, erros, console e stale-generation. Não coberto aqui: imports estáticos/dinâmicos e base relativa, source map, Code Mode, interrupt/timeout, output tardio e nested tools.
4. ✅ Operações internas usam identidade `internal:*` do próprio modo; `ExecutionManager` filtra outputs internos.
5. ⚠️ ALS/late-output parcialmente validado: timer A durante B ainda exige teste dedicado no Deno antes de alegar atribuição confiável; streams tardios sem origem seguem `unattributed`.
6. ✅ Módulo Code Mode executa no `cwd` do projeto (imports relativos preservados) com source map inline.
7. ✅ Outputs internos filtrados por prefixo `internal:`.
8. ⚠️ Budgets centrais em `src/config.ts`; resíduos: maps de late-identities e closed IDs têm tetos próprios documentados, mas falta um teste de stress que prove todos os tetos sob carga.
9. ⚠️ Cleanup em falha de startup e shutdown concorrente implementados; faltam testes de kill externo e morte do pai (órfãos nesse caso ainda possíveis — sem watchdog).
10. ✅ Codec best-effort com metadata de declaração, detecção de aliases/ciclos/getters e exclusão de function/class/import/enum; teste real no Deno (`tests/kernel.integration.ts`) confirma 3 salvos (`count`, `label`, `nums`) e 9 excluídos (identidade compartilhada, ciclo, getter, function, missing e declarações class/import/enum) conforme regra.
11. ✅ Checkpoint falho marca a execução como falha com erro próprio e registra o journal com o estado final.
12. ✅ Checkpoint só ocorre após `settle` das nested calls; exclusividade liberada após término.
13. ✅ `prune` (dry-run + apply, pins protegidos) distinto de `release`.
14. ✅ Intent de promote com recovery no startup (adota head, descarta noop, reporta divergência); forks/tree do Pi seguem com regra de sessão privada por sessão Pi.
15. ✅ Tool única `repl_notebook`, `/repl` administrativo, prompt curto, `README.md`/`LICENSE`/`NOTICE` e CI inicial.

Itens ⚠️ acima são o hardening restante antes de produção.

## 16. Rastreabilidade dos 38 critérios de aceite originais

| Critérios | Entrega responsável | Evidência de aceite |
|---|---|---|
| 1–5: standalone e agnóstico | A/B/I/K | Manifest production install, grafo de imports e busca estática sem decisões por provider/model |
| 6–8: tool única e três caminhos | I | Teste de registro, tools diretas inalteradas e exemplos executados |
| 9–10: TS/Deno e TLA | C/E/F | Suíte real de semântica nos dois modos |
| 11–13: tools reais, autoridade e descoberta | D/I | Provider cooperativo com ToolDefinitions reais, preflight, contexto e atualização dinâmica; limite de invocação universal explicitado |
| 14–16: autocontido, persistente e isolado | E/F | Segunda Code execution sem bindings; Notebook intacto antes/depois |
| 17–22: longa execução, cancelamento, output, lifecycle e geração | C/E/F/J | Wait/yield, races, rich output, late/stale e crash recovery |
| 23–26: snapshots, checkpoint, sessão/projeto e conflitos | G/H | Partial snapshot, atomic failure injection, private fork e CAS A/B |
| 27–29: pins/prune, profiles e journal | H | Proteção de pins, dry-run/apply, collision/rollback e nbformat válido |
| 30–32: lazy, cleanup e recursos | I/J | Zero recursos no load/status, ownership process tests e limites sob stress |
| 33: Linux/macOS/Windows | K | CI real em três plataformas; estrutura multiplataforma sozinha não basta |
| 34–35: coexistência e model switch | I/K | Collision fail-soft e binding persistente após troca de contexto de modelo |
| 36–37: não-sandbox e licenças | A/J/K | README/NOTICE, política de imports e revisão de conteúdo derivado |
| 38: build/lint/typecheck/tests | K | Comandos de verificação aprovados e resultados registrados |

## 17. Origem, licenças e documentação final

Referências possuem MIT, conforme investigação. Registrar em `NOTICE` conceitos e commits consultados. Se qualquer implementação for copiada no futuro, revisar licença do arquivo, preservar copyright e marcar derivação; não inferir licença de vendored code a partir da licença raiz.

Aproveitar:

- Igor Notebook: integração Pi/Deno, snapshots/checkpoints/profiles/project state e journal.
- Igor Code Mode: composição, bridge, contexto, preflight, identidade e conversão de resultados genéricos.
- Prime atual: identidade por execução, protocolo versionado, separação de output, interrupção com grace, geração e lifecycle.

Não portar host V8/Rust histórico, adapters/providers, autenticação, streaming específico, RLM, tools de shell paralelas nem subsistemas autônomos.

A entrega final deve conter arquitetura e justificativa do backend, contratos de protocolo, segurança não-sandbox, política de imports, bridge cooperativo e limite da API Pi, formatos e recovery de persistência, comandos de instalação/uso, exemplos dos dois modos, notices e resultados exatos de verificação por plataforma.

**Definição de pronto:** extensão instalada e exercitada no Pi, com ambos os modos e sua política de isolamento comprovados; não somente compilação, scaffolding ou testes de mocks.
