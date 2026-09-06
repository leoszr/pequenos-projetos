# Review do projeto `pi-repl-notebook`

Data: 2026-04-17

## Escopo

Revisão do projeto inteiro no diretório `pi-repl`, pois ele está não rastreado dentro do repositório Git pai e não há um commit-base próprio para comparar. A referência funcional usada foi `docs/implementation-plan.md`, complementada por `README.md` e pelos contratos descritos em `docs/`.

Nenhum código foi corrigido. Os achados abaixo vêm da minha inspeção e das verificações executadas localmente.

## Resumo

**Resultado: não aprovar como entrega concluída.** Há duas divergências funcionais claras, o gate de lint falha e parte das evidências documentadas não corresponde aos testes existentes.

| Severidade | Quantidade |
|---|---:|
| Alta | 3 |
| Média | 4 |
| Baixa | 1 |

## Achados

### [Alta] `prune` faz parte da API pública, mas sempre falha

- **Local:** `src/tool/router.ts:90-91`
- **Evidência:** o roteador aceita `action: "prune"`, mas lança `prune is not implemented by the current supervisor`.
- **Contradição:** `src/notebook-mode/runtime.ts:174-181` já contém `NotebookRuntime.prune()`, enquanto `docs/implementation-plan.md`, seção 15, item 13, marca a operação como concluída. O README também lista `prune` como funcional.
- **Impacto:** toda chamada pública válida de `prune` falha. O comportamento entregue não corresponde ao contrato anunciado.

### [Alta] Uma cell com erro registra bindings que podem nunca ter sido criados

- **Local:** `src/notebook-mode/runtime.ts:78-89`
- **Evidência:** `declarationMetadata(code)` descobre nomes antes da execução e `discovered.forEach(...)` atualiza `this.bindings` sem verificar `result.status`.
- **Cenário:** uma cell como `throw new Error("x"); const neverCreated = 1` termina com erro, mas `neverCreated` entra no catálogo de bindings.
- **Impacto:** `bindings`, pins, limite de bindings e snapshots passam a operar sobre nomes fantasmas. O snapshot os classifica como excluídos em vez de refletir o estado real do kernel.
- **Teste ausente:** não há teste do catálogo de bindings após falha parcial ou antes da declaração.

### [Alta] O gate documentado de lint falha e torna o job `verify` da CI vermelho

- **Locais:** `tests/notebook-recovery.test.ts:25`, `:29`, `:53`; `.github/workflows/ci.yml:20`; `README.md:5`
- **Evidência executada:** `npm run lint` termina com código 1 e três erros `require-await` nos métodos `FakeKernel.start`, `execute` e `shutdown`.
- **Impacto:** o job `verify` falha em Linux, macOS e Windows antes dos demais gates. A afirmação do README de que lint passa está incorreta.

### [Média] O comando administrativo `/repl` não oferece a superfície prevista

- **Local:** `src/index.ts:111-161`
- **Evidência:** os únicos comandos nomeados são `status`, `policies`, `limits`, `enable` e `disable`; o restante exige enviar JSON bruto.
- **Contradição:** `docs/implementation-plan.md:429` exige administração por `/repl` para restart, checkpoint, reset, terminate, profiles, journal/export, políticas, limites, estado e diagnostics.
- **Impacto:** a integração existe pela tool/JSON, mas a UX administrativa especificada não foi entregue.

### [Média] O bridge HTTP não limita o tempo de leitura do body

- **Locais:** `src/bridge/server.ts:89-145`, `:203-222`; `docs/implementation-plan.md:415`
- **Evidência:** `readBody()` limita bytes, mas não usa timeout ou `AbortSignal`. Uma conexão autenticada pode enviar o corpo lentamente e manter um dos oito slots de `activeRequests` ocupado.
- **Impacto:** até oito requisições lentas podem bloquear o bridge. O próprio plano lista `HTTP body time` como limite necessário.
- **Teste ausente:** cliente autenticado que inicia o body e não o conclui.

### [Média] A validação multiplataforma anunciada pelo plano não existe para o runtime real

- **Local:** `.github/workflows/ci.yml:24-37`
- **Evidência:** a matriz Linux/macOS/Windows executa apenas lint, typecheck, build e unitários. A integração Deno/Jupyter/ZeroMQ roda somente em Ubuntu.
- **Impacto:** sinais, process tree, locks, paths e integração ZeroMQ continuam sem evidência em macOS e Windows. Isso está coerente com o aviso experimental do README, mas não satisfaz os gates K e 33 do plano.

### [Média] A suíte de integração não sustenta todas as alegações de semântica e snapshot

- **Locais:** `tests/kernel.integration.ts:100-131`; `docs/implementation-plan.md`, seção 15, itens 3 e 10
- **Evidência:** o teste real de snapshot comprova somente um binding salvo (`count`) e cinco excluídos. Ele não comprova “3 salvos” como afirma o plano. Também não cobre Code Mode, import relativo, source map, interrupt, timeout, output tardio ou nested tools.
- **Impacto:** a documentação apresenta evidência mais forte do que a suíte realmente fornece.

### [Baixa] O teste de concorrência do kernel não define o comportamento esperado

- **Local:** `tests/kernel.integration.ts:70-78`
- **Evidência:** duas execuções são disparadas em paralelo e o teste aceita tanto `ok` quanto `error` para cada uma.
- **Impacto:** praticamente qualquer resultado não excepcional passa; o teste não protege serialização, rejeição explícita nem integridade do estado após concorrência.

## Verificações executadas

| Comando | Resultado |
|---|---|
| `npm run lint` | **Falhou**: 3 erros `require-await` |
| `npm run typecheck` | Passou |
| `npm run build` | Passou |
| `npm test` | Passou: 44/44 |
| `npm run test:integration` | Passou: 2/2 em Linux com Deno 2.9.6 |
| `npm pack --dry-run --json` | Passou: pacote gerado, 85 entradas |

## Limites desta revisão

- Não houve execução real dentro de uma sessão Pi instalada; a extensão foi validada por build e testes.
- macOS e Windows não foram executados localmente.
- Não foram simulados kill externo, morte do processo pai, slowloris autenticado ou pressão real de memória/RSS.
