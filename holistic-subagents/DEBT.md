# Technical debt

## TD-001 — Handoff pode anteceder o runtime settled

- **Status:** aberto
- **Observado em:** 2026-08-01
- **Área:** protocolo de callback e reconciliação Herdr

### Evidência

No smoke test após `/reload`, o callback `HOLISTIC_HANDOFF_READY` moveu a
Delegation Run para `ready_for_review` enquanto o Agent ainda aparecia como
`working`. Uma inspeção posterior mostrou o mesmo Agent como `idle` e o handoff
completo.

### Risco

O coordenador pode inspecionar ou aceitar cedo demais, antes de o Agent terminar
a resposta final. Isso pode produzir handoff truncado ou evidência incompleta.

### Contorno atual

Após `HOLISTIC_HANDOFF_READY`, confirmar que o runtime está `idle` antes do
aceite quando a primeira inspeção ainda mostrar `working`.

### Resolução desejada

Separar a alegação de handoff da prontidão para revisão. O callback registra a
alegação, mas a Run só fica efetivamente revisável — e só recebe um
`AcceptanceTicket` — depois do evento `agent_settled` correspondente.

### Critérios de aceite

- callback antecipado não permite aceite enquanto o Agent está `working`;
- a Run fica revisável automaticamente após `agent_settled`;
- o handoff inspecionado contém a resposta final completa;
- testes cobrem callback antes e depois de `agent_settled`.
