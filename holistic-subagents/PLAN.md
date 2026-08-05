# Plano atual

## Objetivo

Aplicar as melhorias priorizadas em
`docs/research/holistic-process-assessment.md` sem ampliar o produto além das
evidências da auditoria.

## Etapa 3 — Validar a integração real atual

- Executar smoke instalado contra as versões requeridas de Pi e Herdr.
- Cobrir create/working, claim antes de settled, inspect/accept, reload com
  claim pendente e cleanup de tab.
- Registrar SHA, versões, comandos, resultados e limitações.

## Etapa 4 — Economizar o processo de handoff

- Proibir mensagens pós-handoff sem correção real.
- Limitar output e contexto por etapa.
- Usar `/compact` entre tasks próximas em contexto e `/new` quando o domínio da
  próxima task for materialmente diferente.
- Manter revisão sobre alvo estável e evidência direcionada.
