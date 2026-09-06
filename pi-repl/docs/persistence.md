# Persistência standalone

`StateStore` persiste snapshots e journal usando apenas APIs do Node.js. Ele não inicia nem depende do kernel ou do runtime.

```ts
import { StateStore } from "../src/persistence/store.ts";

const store = new StateStore(root, sessionId, {
  snapshotBytes: 4 * 1024 * 1024,
  bindingBytes: 1 * 1024 * 1024,
  journalBytes: 16 * 1024 * 1024,
  storageBytes: 64 * 1024 * 1024,
});
```

Os valores acima são os limites padrão. Cada limite informado deve ser um inteiro positivo.

## API

- `load()` carrega o último checkpoint da sessão. Retorna `undefined` somente quando ele não existe.
- `checkpoint(snapshot, expectedRevision, projectGeneration)` grava a revisão seguinte. A primeira gravação espera revisão `0`.
- `project()` retorna a geração de projeto atual. Um projeto novo começa na geração `0`, sem snapshot.
- `promote(snapshot, expectedGeneration)` cria uma geração imutável e atualiza o projeto.
- `rollbackProject(targetGeneration, expectedGeneration)` copia uma geração histórica para uma **nova** geração. O histórico nunca é sobrescrito.
- `saveProfile(name, snapshot)` cria um profile. Um nome existente gera erro e não é sobrescrito.
- `listProfiles()` retorna os nomes em ordem alfabética.
- `loadProfile(name)` carrega um profile.
- `appendJournal(entry)` acrescenta uma entrada lógica ao JSONL.
- `journal()` lê e valida todas as entradas.
- `exportNotebook()` converte o journal em um objeto notebook nbformat 4.5.

Conflitos de compare-and-swap geram `RevisionConflictError` ou `GenerationConflictError`. Dados persistidos inválidos geram `PersistenceCorruptionError`. Limites excedidos geram `PersistenceLimitError`.

## Layout

```text
<root>/
  sessions/<sha256(sessionId)>/state.json
  sessions/<sha256(sessionId)>/journal.jsonl
  project/head.json
  project/generations/<n>.json
  profiles/<sha256(name)>.json
```

IDs de sessão e nomes de profile nunca são usados como segmentos de caminho. O nome original do profile fica dentro do arquivo e é conferido na leitura.

## Integridade e concorrência

Operações mutáveis usam um lock exclusivo com `hostname`, PID e token aleatório. A espera é limitada. Um lock só é recuperado automaticamente quando pertence ao mesmo host e seu PID não existe mais. O token também impede que um proprietário remova o lock de outro processo.

Cada arquivo é escrito em um temporário no mesmo diretório, sincronizado com `fsync`, renomeado atomicamente e seguido de `fsync` do diretório. O checkpoint tenta novamente um número limitado de vezes para erros transitórios de I/O.

O journal continua sendo JSONL, mas sua atualização substitui o arquivo completo sob lock. Assim, uma queda não deixa uma última linha parcial visível. Não há rotação nem exclusão automática.

### Limite transacional conhecido

`promote()` confirma a geração do projeto, mas seu contrato não recebe a revisão CAS da sessão. Portanto, o store não pode atualizar com segurança o `projectGeneration` do checkpoint da sessão na mesma operação. Uma queda entre a promoção e o checkpoint seguinte pode deixar a sessão apontando para a base anterior, embora a promoção esteja íntegra no projeto.

A correção mínima proposta é uma operação transacional futura que receba `expectedGeneration` **e** `expectedRevision`. Antes de publicar `head.json`, ela grava um receipt versionado com sessão, revisão, geração anterior, nova geração e hash do snapshot. No startup, o store conclui ou reconhece a operação idempotentemente e só remove o receipt depois do commit da metadata da sessão. Adicionar um receipt ao `promote()` atual sem a revisão esperada esconderia um conflito; por isso ele não é criado silenciosamente nesta API.

## Validação e limites

Snapshots são manifests prontos. O store não serializa objetos do runtime e não decide quais bindings excluir. O chamador fornece cada binding com status `saved` e valor JSON, ou `excluded` e motivo opcional.

A validação rejeita:

- versão, modo, runtime, status ou estrutura incompatíveis;
- `sessionId` divergente em checkpoints de sessão;
- valores não JSON ou com conversão JSON destrutiva, como `undefined`, `bigint`, funções, símbolos, ciclos, aliases de objeto, arrays esparsos, `NaN`, infinitos, `-0`, classes, proxies, accessors e `toJSON` customizado;
- propriedades ou nomes perigosos: `__proto__`, `prototype` e `constructor`;
- bindings, snapshots, journals ou armazenamento acima dos limites.

Quando um orçamento seria excedido, a operação falha antes de publicar a mudança. O store não apaga profiles, gerações ou journal para abrir espaço.

## Intent de promote e recovery

`promote` grava um intent versionado antes de avançar o projeto e o remove após o checkpoint da sessão. Se o processo morrer entre os dois commits, o próximo startup reconcilia: head em `expected+1` adota o snapshot do projeto e persiste a sessão; head inalterado descarta o intent; head além disso registra divergência explícita sem auto-merge. Métodos: `writePromoteIntent`, `readPromoteIntent`, `clearPromoteIntent` e leitura de gerações históricas via `projectSnapshot(generation)`.

## Notebook exportado

Cada entrada do journal vira uma célula de código. IDs incompatíveis com nbformat são convertidos em hashes estáveis. Outputs `stdout` e `stderr` viram `stream`; `result` vira `execute_result`; `error` vira `error`; os demais viram `display_data`. O retorno contém `nbformat: 4` e `nbformat_minor: 5` e pode ser serializado diretamente com `JSON.stringify`.
