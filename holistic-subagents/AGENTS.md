# Project Instructions

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
