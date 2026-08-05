# ADR 0003: Usar manifests estruturados no handoff

## Status

Parcialmente superada pela ADR 0004

## Contexto

O handoff usava as últimas linhas do pane como evidência principal. Esse trecho
é truncado, mistura conversa com resultado e não fornece identidade ou
integridade para arquivos grandes. Callbacks também não distinguiam prompts
sucessivos da mesma Run.

## Decisão

Cada prompt do pai inicia um Handoff Cycle imprevisível. Runs novas publicam um
Handoff Manifest JSON versionado e o callback autenticado informa ciclo, ID do
manifest e SHA-256 dos bytes finais. A Run só fica revisável após claim,
trabalho observado e `agent_settled` do mesmo ciclo.

Artifacts grandes ficam em roots locais registrados da Agent Session. Cada
Artifact Ref usa ID opaco, media type, tamanho e SHA-256. Roots temporários são
somente data plane descartável; lifecycle, mensagens e estado durável continuam
no Pi/Herdr. Arquivos duráveis permanecem no cwd/worktree e na auditoria de
autoridade.

`holistic_inspect` valida manifest, artifacts, runtime e autoridade antes de
emitir um Acceptance Ticket vinculado ao ciclo, revisão, Session Mutation
Sequence e hash. Runs legadas continuam inspecionáveis pelo pane; Runs novas
nunca usam transcript para contornar manifest ausente ou inválido. A
compatibilidade legada desta frase foi posteriormente removida pela ADR 0004.

## Consequências

- O resultado completo não depende de output recente ou truncado.
- Reload preserva a identidade e a integridade do handoff.
- `/tmp` fornece namespacing e integridade, não isolamento forte entre processos
  do mesmo usuário.
- Publicação e cleanup exigem validação de containment, symlink, ownership,
  permissões, limites e hash.

## Alternativas rejeitadas

- Usar `/tmp` como message bus ou control plane: duplicaria estado durável e
  lifecycle já fornecidos por Pi/Herdr.
- Manter transcript como fonte principal: não resolve truncamento nem
  integridade.
- Criar método Herdr novo agora: amplia o protocolo sem necessidade; o callback
  textual autenticado continua suficiente para o claim curto.
