# Resultados de teste

Data: 2026-07-15

Ambiente: repositório Git descartável criado em `/tmp`, sessões Pi interativas
controladas pelo Herdr e removidas ao final.

## Integração e validação estática

- integração Pi do Herdr atualizada de v3 para v4;
- `herdr integration status`: `pi: current`;
- `python holistic-subagents/scripts/validate.py`: passou;
- seis model IDs disponíveis e todas as nove combinações modelo/thinking
  possuem comando correspondente.

## Sessão read-only e follow-up

- modelo: GPT-5.6 Luna medium;
- sessão iniciou em pane sem foco e reportou `idle → working → idle`;
- leu três arquivos e retornou resumo correto;
- follow-up executado na mesma sessão e preservou contexto;
- uma importação Python criou `__pycache__`, apesar da declaração de que nenhum
  arquivo havia sido alterado;
- documentação atualizada para exigir `git status` após trabalho read-only e
  recomendar `PYTHONDONTWRITEBYTECODE=1` quando aplicável.

## Implementação em worktree

- modelo: GPT-5.6 Luna xhigh;
- worktree e branch criados pelo Herdr;
- implementação e testes respeitaram ownership de dois arquivos;
- commit focado criado;
- sessão em workspace não focado reportou `idle → working → done`;
- `pytest` não estava instalado; a sessão executou fallback manual;
- validação independente confirmou comportamento, diff sem whitespace errors e
  worktree limpa;
- worktree, branch, workspace e fixture foram removidos.

## Espera por decisão e retomada

- `ask_user` abriu corretamente e recebeu a escolha `BETA` via
  `herdr pane send-keys`;
- a sessão retomou e concluiu;
- durante o modal, Herdr permaneceu em `working` e não mudou para `blocked`;
- documentação atualizada para não depender exclusivamente de `blocked` e para
  inspecionar o pane quando `working` não progride.

## Cleanup

- nenhum pane, workspace, worktree, branch ou diretório E2E permaneceu;
- a skill continuou não instalada.

## Piloto explícito com `--skill`

- uma sessão coordenadora foi iniciada com `--skill <path>` sem instalação;
- tarefa trivial: respondeu diretamente e não criou pane auxiliar;
- bug real em fixture pequena: carregou a skill, corrigiu diretamente e
  justificou que delegação custaria mais que o trabalho;
- pedido crítico de verificação independente: criou pane auxiliar, escolheu Sol
  medium pela tabela, enviou brief read-only, acompanhou, pediu follow-up,
  validou novamente e fechou o pane;
- comportamento de ativação considerado correto: sem overdelegation nas duas
  primeiras tarefas e delegação quando independência trouxe ganho real;
- observado polling excessivo com `sleep`; referência Herdr atualizada para
  preferir `wait agent-status` e inspecionar somente após timeout.

## Smoke tests de modelos

Todos os seis IDs permitidos foram exercitados em sessões Pi interativas com
tool call local e follow-up:

- GPT-5.6 Luna: medium e xhigh passaram;
- GPT-5.6 Terra medium passou;
- GPT-5.6 Sol medium passou em tarefa real e review independente;
- DeepSeek V4 Flash high passou;
- DeepSeek V4 Pro high passou;
- GLM 5.2 high passou.

Terra e DeepSeek Flash revelaram uma condição de startup: `idle` pôde aparecer
antes de a TUI terminar de carregar. O envio imediato deixou texto sem
submissão. Ambos passaram após confirmar visualmente o prompt. A referência
Herdr agora exige confirmação da TUI depois do primeiro `idle`.

## Instalação global

- instalada em `~/.pi/agent/skills/holistic-subagents`;
- validador executado com sucesso sobre a cópia instalada;
- fonte e cópia instalada comparadas sem diferenças;
- nova sessão Pi sem `--skill` mostrou 16 skills carregadas, contra 15 antes da
  instalação, confirmando descoberta global;
- nenhum pane ou workspace de smoke test permaneceu aberto.

## Protocolo de retorno ao agente principal

- parent pane ID injetado no filho por `HOLISTIC_PARENT_PANE_ID`;
- filho executou trabalho, enviou uma mensagem curta com
  `[HOLISTIC_HANDOFF_READY]` e concluiu normalmente;
- agente principal recebeu a mensagem como novo input e respondeu
  `ACK_PARENT_SIGNAL`;
- resultado completo permaneceu no pane filho;
- parent e child terminaram em `done` e todos os recursos foram removidos;
- validado que `herdr pane run` é adequado para submissão; `herdr agent send`
  não foi usado porque envia texto sem Enter.

## Post-mortem de sessão real: polling apesar do callback

Sessão analisada:
`pi-session-2026-07-16T17-09-09-651Z_019f6be7-5193-7e93-a704-d47319c88af4.html`.

- três filhos foram despachados e confirmados em `working`;
- o pai abriu três `herdr wait agent-status ... --status done --timeout
  1800000`, mas cada comando virou uma sessão de `exec_command` separada;
- em vez de confiar no callback, o pai fez pelo menos 12 consultas curtas com
  `write_stdin(... yield_time_ms=1000)` e nove leituras de pane nos primeiros
  quatro minutos, além de probes repetidos de processos e arquivos;
- os três callbacks `[HOLISTIC_HANDOFF_READY]` chegaram corretamente às
  18:17:02, 18:41:28 e 18:54:50;
- o pai reagiu aos callbacks em 14–18 segundos, comprovando que polling não era
  necessário para receber conclusão;
- uma inspeção antecipada encontrou um fade incorreto e foi útil, mas ocorreu
  sem checkpoint previamente declarado; a política agora separa checkpoints
  de risco de curiosidade sobre progresso;
- documentação atualizada para usar callback como caminho padrão, encerrar o
  turno do pai após dispatch e reservar espera síncrona para fallback;
- para vários filhos, a referência agora exige fan-in em um processo com
  `wait -n`, em vez de várias sessões que precisem ser consultadas;
- loops de `write_stdin` curto, reads de pane e probes de arquivos/processos
  durante execução foram explicitamente proibidos.
