# Revisão das correções

## Resultado

**Não aprovar ainda.** Das oito observações anteriores, quatro foram corrigidas, duas ficaram parciais e duas foram corrigidas com pendências de validação. Há uma regressão funcional nova no rastreamento de bindings e o lint continua falhando.

Nenhum código foi corrigido nesta revisão.

## Estado dos achados anteriores

| Achado anterior | Estado | Evidência |
|---|---|---|
| `prune` sempre falhava | **Parcial** | Agora chega a `NotebookRuntime.prune()`, mas sempre usa o default `dryRun = true`; a API pública não oferece campo para aplicar o prune. |
| Cell com erro registrava bindings inexistentes | **Regrediu de outra forma** | O filtro por `result.status === "ok"` remove os fantasmas, mas também deixa de registrar bindings reais criados antes de um erro. |
| Lint falhava | **Ainda falha** | Os três erros antigos foram removidos, mas surgiu um `no-control-regex` em `tests/kernel.integration.ts:76`. |
| `/repl` incompleto | **Corrigido** | Foram adicionados restart, checkpoint, reset, terminate, profiles, journal/export, state, snapshot, project e diagnostics. |
| Bridge sem timeout de body | **Parcial** | Retorna 408, mas não cancela nem destrói a leitura/socket que perdeu o `Promise.race`. |
| Integração só em Linux na CI | **Corrigido na configuração** | O job de integração agora usa Ubuntu, macOS e Windows. Ainda não há resultado de execução da CI neste projeto não rastreado. |
| Snapshot real não provava três salvos | **Corrigido** | O teste real agora verifica `count`, `label` e `nums` como salvos e várias exclusões. |
| Concorrência aceitava qualquer status | **Corrigido** | O teste exige ambos `ok`, resultados 43/44 e estado final 44. |

## Achados atuais

### [Alta] Cells parcialmente executadas perdem bindings reais do catálogo e do checkpoint

- **Local:** `src/notebook-mode/runtime.ts:78-96`
- **Mudança:** bindings descobertos só são registrados quando `result.status === "ok"`.
- **Reprodução real:** executei `const survived = 123; throw new Error("after")` no Deno Jupyter. A execução retornou `error`, mas a cell seguinte avaliou `survived` como `123`.
- **Impacto:** o valor continua vivo no kernel, porém não aparece em `bindings`, não pode ser pinado e não entra no snapshot/checkpoint. Um restart o perde sem que o manifest registre a exclusão.
- **Teste novo insuficiente:** `tests/notebook-recovery.test.ts:142-174` cobre apenas erro antes da declaração (`throw ...; const neverCreated`), não declaração bem-sucedida seguida de erro.

### [Alta] `prune` público nunca aplica as remoções

- **Locais:** `src/tool/router.ts:90-91`, `src/notebook-mode/runtime.ts:174-181`, `src/tool/request.ts:77-85`
- **Evidência:** o roteador chama `notebook.prune(names, scope)` sem terceiro argumento. O runtime define `dryRun = true`. O schema não aceita `dry_run`, `apply` ou operação equivalente.
- **Impacto:** toda chamada pública de `prune` retorna somente a prévia. O caminho `dryRun = false` é inalcançável pela tool.
- **Teste ausente:** não há ocorrência de `prune` em `tests/`.

### [Média] O timeout do body responde, mas deixa a leitura pendente

- **Locais:** `src/bridge/server.ts:202-238`, `tests/bridge.test.ts:438-472`
- **Evidência:** quando o timer vence, `Promise.race` rejeita, mas `readChunks(request, maxBytes)` continua aguardando o stream. O código apenas adiciona `pending.catch()`; não aborta ou destrói o request/socket.
- **Impacto:** `activeRequests` é decrementado e novos pedidos são aceitos, enquanto conexões e tarefas antigas podem continuar abertas. Um cliente autenticado pode repetir o processo e acumular recursos fora do limite de oito requests.
- **Teste insuficiente:** o teste destrói o cliente depois de 4 segundos e só verifica que outro request passa. Ele não comprova que o servidor encerrou a conexão nem que a leitura terminou no timeout.

### [Média] O gate de lint segue vermelho após a correção

- **Local:** `tests/kernel.integration.ts:76`
- **Evidência executada:** `npm run lint` falha em `no-control-regex` por causa de `/\u001b\[[0-9;]*m/g`.
- **Impacto:** os jobs `verify` da CI continuam falhando em todas as plataformas, apesar de os erros `require-await` anteriores terem sido corrigidos.

### [Baixa] Os novos comandos `/repl` não têm teste de roteamento próprio

- **Local:** `src/index.ts:175-300`
- **Evidência:** a busca em `tests/extension.test.ts` não encontrou casos exercitando a sintaxe textual nova de restart, terminate, profile, journal, project ou diagnostics.
- **Impacto:** parsing, mensagens de uso e montagem das requisições podem regredir sem detecção. Typecheck apenas confirma os tipos internos.

## Verificações executadas

| Comando | Resultado |
|---|---|
| `npm run lint` | **Falhou**: 1 erro `no-control-regex` |
| `npm run typecheck` | Passou |
| `npm run build` | Passou |
| `npm test` | Passou: 46/46 |
| `npm run test:integration` | Passou: 2/2 em Linux com Deno 2.9.6 |
| `npm pack --dry-run --json` | Passou |
| Probe de binding após erro parcial | Confirmou que o Deno mantém `survived = 123` após a cell retornar erro |

## Limites

- O diretório `pi-repl` continua não rastreado no repositório Git pai. Não foi possível obter um diff confiável; as correções foram identificadas por conteúdo, timestamps e comparação com `REVIEW.md`.
- Não executei a CI remota nem validei macOS/Windows localmente.
- Não fiz uma instalação real dentro do Pi nesta rodada.
