# Workflow de Subagentes Efêmeros com Herdr

> **Obsoleto:** este documento é mantido apenas como histórico de design. A
> fonte operacional atual é `holistic-subagents/SKILL.md` e suas referências.
> Em caso de divergência, siga a skill.

Este documento define como o agente coordenador pode criar subagentes sob demanda para implementação, review, auditoria, testes, pesquisa ou qualquer outro papel necessário, sem cadastrar agentes fixos previamente.

A inspiração é o padrão de **subagentes efêmeros gerados em tempo de execução**: o papel não é uma entidade permanente. Ele é um contrato curto criado para uma tarefa específica, executado em contexto isolado e descartado depois do handoff.

Referência conceitual: [experimento de Giuseppe com subagentes efêmeros gerados pelo Pi a partir de poucas instruções em `AGENTS.md`](https://x.com/giuseppegurgone/status/2076223568946344124).

## Objetivo

Permitir este ciclo com baixo atrito:

```text
pedido
  → decomposição
  → subagente criado sob demanda
  → trabalho verificável
  → review independente
  → correção pelo responsável
  → validação do coordenador
  → merge
  → limpeza
```

O sistema deve favorecer:

- isolamento de contexto;
- papéis definidos no momento do uso;
- paralelismo seguro;
- responsabilidade clara;
- revisão independente;
- evidência antes de integração;
- sessões persistentes para ciclos de correção;
- descarte completo após integração.

---

## 1. Princípio central: papel dinâmico, sessão efêmera

Não existe catálogo obrigatório de agentes.

O coordenador cria um papel quando identifica uma necessidade:

- implementar uma mudança;
- revisar um diff;
- investigar uma falha;
- testar um fluxo;
- pesquisar uma API;
- auditar segurança ou performance;
- validar UI;
- produzir documentação;
- resolver conflitos de integração.

Nomes como `worker`, `reviewer`, `auditor` e `tester` são exemplos, não definições permanentes. Um papel novo pode ser criado a qualquer momento, desde que seu contrato informe:

1. missão;
2. contexto mínimo;
3. escopo e ownership;
4. restrições;
5. critérios de aceite;
6. evidências exigidas;
7. formato do handoff.

### Regra prática

> Não pré-defina o agente. Defina o resultado, os limites e a evidência no momento da delegação.

---

## 2. Regras obrigatórias deste projeto

Toda delegação deve:

1. ocorrer dentro de um ambiente Herdr;
2. criar uma tab/workspace dedicada;
3. iniciar uma nova sessão interativa do Pi;
4. usar um modelo adequado à tarefa, escolhido pelo coordenador;
5. usar um thinking level adequado à tarefa, escolhido pelo coordenador;
6. nomear a sessão conforme papel e tarefa;
7. executar no diretório ou worktree correto;
8. manter a sessão viva até review, correções e handoff final.

O coordenador escolhe modelo e thinking level conforme complexidade, risco,
custo, latência, janela de contexto e disponibilidade. Quando as escolhas
precisarem ser explícitas:

```bash
pi --model "<provider/model>" \
  --thinking "<level>" \
  --name "<papel> — <tarefa>"
```

Qualquer uma das opções pode ser omitida para usar o padrão configurado no Pi:

```bash
pi --name "<papel> — <tarefa>"
```

É proibido delegar por:

- processo em background sem tab dedicada;
- prompt one-shot;
- sessão efêmera sem possibilidade de follow-up;
- sessão Pi atual do coordenador.

Antes de usar Herdr:

```bash
test "${HERDR_ENV:-}" = 1
```

Se o comando falhar, não controlar a sessão Herdr externamente.

---

## 3. Responsabilidades

## Coordenador

O coordenador permanece responsável pelo resultado final. Delegação não transfere a responsabilidade de integração.

Deveres:

- entender o pedido;
- ler as regras e o estado do projeto;
- decompor somente quando houver ganho real;
- identificar dependências e conflitos;
- gerar contratos de papel sob demanda;
- criar tabs/worktrees;
- registrar pane, workspace, branch e ownership;
- acompanhar bloqueios sem microgerenciar;
- revisar diffs e evidências;
- encaminhar achados ao agente responsável;
- executar validação independente;
- fazer merge em ordem segura;
- remover worktrees e branches criadas;
- atualizar documentação operacional após integração.

O coordenador não deve aceitar como prova apenas frases como “funciona”, “testado” ou “concluído”.

## Subagente

O subagente recebe autoridade limitada ao contrato da tarefa.

Deveres:

- ler os documentos obrigatórios;
- respeitar ownership e limites;
- inspecionar antes de editar;
- produzir commits focados;
- testar critérios de aceite;
- informar falhas sem ocultá-las;
- permanecer disponível para correções;
- entregar handoff verificável;
- não fazer merge na branch integrada, salvo ordem explícita.

---

## 4. Quando criar um subagente

Crie um subagente quando ao menos uma condição for verdadeira:

- a tarefa possui ownership isolável;
- pode avançar paralelamente sem dependência imediata;
- review independente aumenta a confiança;
- a investigação geraria muito ruído no contexto principal;
- exige especialização ou foco diferente;
- precisa de uma sessão persistente para ciclos de correção;
- o trabalho pode ser validado por diff, testes, logs ou artefatos.

Evite criar um subagente quando:

- a mudança é trivial e local;
- o custo de coordenação supera o trabalho;
- dois agentes precisariam editar o mesmo arquivo central ao mesmo tempo;
- a tarefa ainda não possui entrada ou critério de aceite suficiente;
- a delegação serviria apenas como “teatro de paralelismo”.

---

## 5. Contrato de papel gerado em tempo de execução

Antes de abrir a sessão, o coordenador sintetiza uma **Role Card**. Ela não precisa existir em arquivo nem ser reutilizada.

```md
## Papel
<nome descritivo criado agora>

## Missão
<um resultado observável>

## Contexto mínimo
- <documentos e decisões relevantes>
- Base: <commit/branch>

## Ownership
- Pode editar: <paths>
- Somente leitura: <paths>
- Não tocar: <paths>

## Critérios de aceite
- <comportamento verificável>
- <testes obrigatórios>

## Restrições
- <limites técnicos e de produto>

## Entrega
- commits;
- arquivos alterados;
- comandos e resultados;
- decisões;
- limitações;
- riscos e trabalho pendente.
```

### Exemplos de papéis criados sob demanda

| Necessidade detectada | Papel que pode ser gerado |
|---|---|
| Implementação | `worker-player-movement` |
| Review de estado e timers | `reviewer-state-lifecycle` |
| Teste de conclusão duas vezes | `tester-replay-flow` |
| Auditoria visual | `reviewer-visual-comfort` |
| Pesquisa de API | `researcher-babylon-postprocess` |
| Análise de bundle | `auditor-bundle-performance` |
| Correção de merge | `integrator-wave-4` |

A tabela é ilustrativa. O coordenador pode gerar qualquer papel necessário.

---

## 6. Escolha do isolamento

## Trabalho que altera código

Use branch e worktree próprias. Um worktree Herdr já fornece workspace, tab e pane isolados.

```bash
herdr worktree create \
  --cwd /caminho/do/projeto \
  --branch agent/<slug-da-tarefa> \
  --base <branch-ou-commit-base> \
  --label "<papel> — <tarefa>" \
  --no-focus \
  --json
```

Leia do JSON retornado:

- `workspace.workspace_id`;
- `root_pane.pane_id`;
- `worktree.path`;
- `worktree.branch`.

Nunca invente IDs do Herdr.

## Review somente leitura

O reviewer deve receber um snapshot estável: commit ou branch do worker. Não revise trabalho mutando enquanto o worker ainda edita os mesmos arquivos.

Opções seguras:

1. criar worktree de review a partir do commit de handoff;
2. abrir tab dedicada na `main` e revisar com `git diff <base>...<branch>` sem editar;
3. criar branch temporária `review/<slug>` baseada na branch entregue.

Preferência: worktree separada quando o reviewer precisar executar build/testes ou explorar o código livremente.

## Pesquisa sem alteração

Pode usar tab dedicada no checkout atual, desde que:

- não edite arquivos;
- não altere estado Git;
- não use processos que conflitem com portas ou recursos compartilhados;
- entregue fontes, conclusões e incertezas.

---

## 7. Inicialização padrão no Herdr

Após criar a topologia, nomeie a pane e inicie apenas a sessão interativa:

```bash
herdr pane rename <pane-id> "<papel> · Pi"

herdr pane run <pane-id> \
  'pi --name "<papel> — <tarefa>"'
```

Adicione `--model` e/ou `--thinking` quando a delegação exigir escolhas
explícitas diferentes dos padrões do Pi.

Espere o Pi ficar disponível:

```bash
herdr wait agent-status <pane-id> --status idle --timeout 60000
```

Depois envie a Role Card e a tarefa:

```bash
herdr pane run <pane-id> "<prompt completo da delegação>"
```

Não passe a tarefa como argumento one-shot do executável Pi.

### Confirmação de início

```bash
herdr wait agent-status <pane-id> --status working --timeout 30000
```

Se não entrar em `working`:

1. leia a pane;
2. confirme se o prompt foi submetido;
3. só envie `Enter` manualmente se o texto estiver visivelmente parado no editor.

```bash
herdr pane read <pane-id> --source recent-unwrapped --lines 80
```

---

## 8. Máquina de estados da delegação

```text
DISCOVERED
   ↓
DISPATCHED
   ↓
WORKING ───────────────┐
   ↓                   │
HANDOFF_READY          │
   ↓                   │
UNDER_REVIEW           │
   ├── ACCEPTED        │
   └── CHANGES_REQUESTED
             ↓         │
          WORKING ─────┘

ACCEPTED
   ↓
INTEGRATED
   ↓
VERIFIED
   ↓
CLEANED_UP
```

Estados Herdr observáveis:

- `unknown`: sessão ainda não detectada;
- `idle`: agente disponível ou resultado já visto;
- `working`: tarefa em execução;
- `blocked`: precisa de entrada;
- `done`: concluiu em contexto não focado.

`idle` e `done` podem ambos significar conclusão. Sempre confirme com `pane get` e leia a saída.

```bash
herdr pane get <pane-id>
herdr pane read <pane-id> --source recent-unwrapped --lines 120
```

Não dependa exclusivamente de um `wait ... --status done`: se a tab estiver focada, a conclusão pode aparecer como `idle`.

---

## 9. Prompt universal de worker

```md
Você é um subagente efêmero criado sob demanda no Herdr.

Papel desta sessão:
<papel dinâmico>

Missão:
<resultado verificável>

Antes de editar:
- leia AGENTS.md, SPRINTS.md, PARALLEL_DEVELOPMENT_PLAN.md e PROJECT_STATUS.md;
- leia os arquivos diretamente relacionados;
- confirme internamente branch, base e ownership.

Ownership:
- pode editar: <paths>;
- somente leitura: <paths>;
- não editar: <paths>.

Critérios de aceite:
- <critério 1>;
- <critério 2>;
- npm run build deve passar.

Restrições:
- não faça merge na main;
- não altere escopo sem escalar;
- não marque como verificado o que não testou;
- não esconda limitações;
- faça commits focados.

Handoff obrigatório:
- hashes dos commits;
- arquivos alterados;
- testes e resultados exatos;
- decisões;
- limitações e riscos;
- worktree limpa.
```

---

## 10. Prompt universal de reviewer independente

```md
Você é um reviewer efêmero e independente criado sob demanda no Herdr.

Revise <branch/commit/diff> contra <spec/critérios>.
Não presuma que a intenção do worker está correta.
Não aprove apenas porque build e testes passaram.

Inspecione:
- correção funcional;
- aderência ao escopo;
- regressões;
- estados inalcançáveis;
- timers, retries, reset e dispose;
- concorrência e race conditions;
- contratos entre módulos;
- erros silenciosos e fallbacks perigosos;
- testes ausentes ou tautológicos;
- segurança, performance e acessibilidade quando relevantes.

Não edite código, salvo instrução explícita.

Para cada achado, entregue:
- severidade: blocker, high, medium ou low;
- arquivo e linha/símbolo;
- cenário de reprodução;
- impacto;
- causa;
- solução recomendada.

Finalize com um veredito:
- APPROVE;
- APPROVE_WITH_NOTES;
- REQUEST_CHANGES.
```

---

## 11. Handoff padronizado

Todo worker que altera código deve responder neste formato:

```md
## Handoff

### Resultado
<concluído | concluído com limitações | bloqueado>

### Commits
- `<hash>` — <descrição>

### Arquivos alterados
- `<path>` — <motivo>

### Testes
- `<comando>` — <resultado>

### Decisões
- <decisão e justificativa>

### Limitações
- <o que não foi validado>

### Riscos
- <possíveis regressões ou integração necessária>

### Estado Git
- worktree limpa: <sim/não>
```

Sem commit, sem teste ou com worktree suja: handoff incompleto, salvo tarefa explicitamente somente investigativa.

---

## 12. Review e ciclo de correção

O reviewer ou coordenador deve reportar achados ao agente responsável. A mesma sessão permanece aberta para preservar contexto.

```bash
herdr pane run <worker-pane-id> \
  "Review encontrou: <erro>. Cenário: <reprodução>. Causa: <causa>. Solução esperada: <solução>. Corrija, teste, faça commit e informe o hash."
```

O feedback deve conter **erro e direção de solução**, não apenas “não funciona”.

Depois da correção:

1. ler o novo handoff;
2. revisar somente o delta e as interações afetadas;
3. executar testes novamente;
4. repetir até não haver bloqueadores.

O reviewer não deve assumir automaticamente o ownership da correção. A correção volta primeiro ao worker responsável.

---

## 13. Validação do coordenador

Mesmo com `APPROVE`, o coordenador deve executar validação independente.

Checklist mínimo:

```bash
git diff --check <base>...<branch>
git diff --stat <base>...<branch>
git log --oneline <base>..<branch>
npm run build
```

Quando existirem:

```bash
npm test
npm run test:harness
npm run lint
```

Também verificar:

- diff fora do ownership;
- arquivos gerados acidentalmente;
- dependências novas;
- logs/debug deixados no código;
- alterações não relacionadas;
- documentação que afirma testes não executados;
- comportamento em reset/replay;
- console do navegador para aplicações web.

Build verde é necessário, não suficiente.

---

## 14. Integração

Integre uma branch por vez, em ordem de dependência.

```bash
git merge --no-ff agent/<slug> -m "merge: <tarefa>"
```

Após cada merge:

1. resolver conflitos conscientemente;
2. executar testes focados;
3. executar build integrado;
4. verificar o fluxo afetado;
5. atualizar `PROJECT_STATUS.md` na `main`.

Nunca marque uma tarefa como integrada apenas porque a branch foi criada ou o worker terminou.

---

## 15. Limpeza

Limpeza ocorre somente após merge e validação final.

Remova o worktree pelo workspace que o coordenador criou:

```bash
herdr worktree remove --workspace <workspace-id> --force --json
```

Depois remova a branch:

```bash
git branch -d agent/<slug>
```

Confirme:

```bash
git status --short --branch
git branch --all
git worktree list
```

Não feche ou remova panes, tabs, workspaces ou worktrees que não foram criados por este fluxo.

---

## 16. Paralelismo e ownership

Antes de despachar múltiplos workers, crie uma tabela operacional:

| Papel dinâmico | Branch | Base | Pode editar | Não pode editar | Depende de |
|---|---|---|---|---|---|
| `worker-a` | `agent/a` | `main` | `src/a/**` | `src/game/Game.ts` | — |
| `worker-b` | `agent/b` | `main` | `src/b/**` | `src/game/Game.ts` | — |
| `integrator` | `agent/integration` | `main` | arquivos centrais | módulos dos workers | A + B |

Regras:

- um arquivo central possui um único owner por onda;
- workers paralelos não editam o mesmo contrato sem coordenação;
- integrações centrais ficam para uma fase explícita;
- dependências são integradas antes dos consumidores;
- documentação de status é atualizada depois da integração, não por todos os workers concorrentes.

---

## 17. Padrões de composição

## Worker → Reviewer → Worker

Fluxo padrão para mudança de código:

```text
worker implementa
reviewer independente procura falhas
worker corrige
coordenador valida
coordenador integra e limpa
```

## Workers paralelos → Integrator → Reviewer

Para frentes independentes:

```text
worker A ─┐
worker B ─┼→ integrator → reviewer → correções → merge
worker C ─┘
```

## Researcher → Worker

Quando a implementação depende de documentação atual:

```text
researcher entrega fontes e decisão
worker implementa sobre decisão aceita
reviewer verifica implementação e uso correto da API
```

## Auditor → Worker

Quando existe código pronto, mas baixa confiança:

```text
auditor gera achados reproduzíveis
worker responsável corrige
auditor ou reviewer confirma o delta
```

Papéis podem ser combinados livremente. O workflow define contratos e gates, não uma equipe fixa.

---

## 18. Anti-patterns

Evite:

- criar subagente sem missão verificável;
- usar um mesmo agente como autor e única autoridade de aprovação;
- delegar trabalho conflitante em branches paralelas;
- enviar todo o histórico quando poucos arquivos bastam;
- confiar somente no resumo do agente;
- aceitar “build passou” como prova funcional completa;
- reviewer corrigir silenciosamente o trabalho do worker;
- fazer merge antes do ciclo de correção;
- apagar branch antes de confirmar integração;
- abandonar worktrees e tabs;
- esperar apenas por `done` e ignorar `idle`;
- inventar IDs Herdr;
- usar `--force` para esconder worktree suja antes do handoff;
- promover teste automatizado a validação manual sem evidência.

---

## 19. Checklist rápido do coordenador

### Dispatch

- [ ] Li regras e status do projeto.
- [ ] Há benefício real em delegar.
- [ ] Gerei uma Role Card específica.
- [ ] Defini base, branch, ownership e dependências.
- [ ] Criei tab/worktree Herdr dedicada.
- [ ] Iniciei Pi com modelo e thinking adequados à tarefa.
- [ ] Confirmei estado `working`.

### Handoff

- [ ] Há commits focados.
- [ ] A worktree está limpa.
- [ ] Testes e limitações foram informados.
- [ ] O diff respeita ownership.

### Review

- [ ] Review foi independente.
- [ ] Achados têm cenário, impacto e solução.
- [ ] Erros voltaram ao worker responsável.
- [ ] Correções receberam novo commit e reteste.

### Integração

- [ ] Executei validação independente.
- [ ] Merge respeitou dependências.
- [ ] Build/testes integrados passaram.
- [ ] Atualizei o status real do projeto.
- [ ] Removi worktree e branch criadas.
- [ ] `main` terminou limpa.

---

## 20. Regra final

> Subagentes são capacidades temporárias, não cargos permanentes.

O coordenador deve ser capaz de inventar o papel necessário no momento em que a necessidade surge, fornecer um contrato mínimo e verificável, manter a sessão disponível para feedback e descartá-la depois que o resultado for revisado, integrado e validado.
