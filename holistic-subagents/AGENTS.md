# Project Instructions

## Plano atual

- `PLAN.md` contém somente trabalho atual, aprovado e ainda não implementado.
- Antes de alterar ou executar o plano, confronte cada item com o código, testes,
  ADRs e commits atuais. Remova imediatamente itens concluídos, superados ou
  contraditórios.
- Ao concluir uma etapa, retire-a do `PLAN.md` na mesma mudança. Não mantenha
  checklists concluídos, histórico de implementação ou contexto stale.
- Use Git, ADRs, `CONTEXT.md` e documentação de pesquisa para preservar
  histórico e decisões; `PLAN.md` não é changelog.

## Publicação e atualização no Pi

- Este diretório é desenvolvido dentro do monorepo `leoszr/pequenos-projetos`.
- A instalação persistente do Pi deve usar somente
  `git:github.com/leoszr/holistic-subagents`. Não substitua essa origem por um
  path local.
- Para testes locais temporários, use `pi -e .`.
- Antes de publicar, faça commit e execute `npm run check`.
- Publique a subpasta a partir da raiz do monorepo:

  ```bash
  git subtree push \
    --prefix=holistic-subagents \
    https://github.com/leoszr/holistic-subagents.git \
    master
  ```

- O clone instalado pelo Pi só deve ser atualizado depois dessa publicação:

  ```bash
  pi update --extension git:github.com/leoszr/holistic-subagents
  ```

- Execute `/reload` no Pi após a atualização.
- Não use force push para publicar a subtree. Se a publicação falhar, preserve
  ambos os históricos e investigue antes de tentar novamente.
