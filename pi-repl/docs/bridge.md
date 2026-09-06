# Bridge standalone

O bridge permite que uma execução `code` ou `notebook` chame ferramentas do host sem usar `getAllTools()` como executor. `getAllTools()` fornece somente metadados. A execução real exige um `ToolProvider` explícito.

## Responsabilidade do host

O `ToolProvider` deve executar a ferramenta pelo caminho cooperativo do host:

```ts
interface ToolProvider {
  list(): ToolInfo[];
  resolve(name: string): {
    definition: ToolDefinition;
    capabilities: ToolCapabilities;
  } | undefined;
  preflight(name: string, args: unknown, context: NestedContext): Promise<void>;
  invoke(name: string, args: unknown, context: NestedContext): Promise<unknown>;
}
```

`preflight` deve aplicar aprovação, políticas e eventos necessários antes da execução. `invoke` deve preservar o middleware, os eventos e o resultado completo do host. O bridge não chama `ToolDefinition.execute` diretamente, pois isso contornaria essas responsabilidades.

Sem provider, `list()` retorna vazio e `invoke()` falha fechado.

## ToolRegistry

```ts
new ToolRegistry(
  discover: () => ToolInfo[],
  active: () => string[],
  provider?: ToolProvider,
)
```

API pública:

- `setProvider(provider?)`: troca ou remove o provider.
- `list(mode)`: retorna a interseção dinâmica entre ferramentas descobertas, ativas e fornecidas que podem executar no modo.
- `policies()`: informa os limites e requisitos fixos.
- `invoke(name, args, execution)`: valida e executa uma chamada cooperativa.
- `openExecution(executionId)`: limpa o estado encerrado antes de reutilizar um ID sem chamadas pendentes.
- `closeExecution(executionId)`: rejeita novas chamadas imediatamente.
- `settle(executionId, timeoutMs?)`: espera as chamadas pendentes. Retorna `false` ao expirar o prazo.

### Fluxo de uma chamada

1. Confirma provider, metadado descoberto, ferramenta ativa e ferramenta fornecida.
2. Rejeita `repl_notebook`, ferramenta interativa, não aninhável, não cancelável ou incompatível com o modo.
3. Aplica `ToolDefinition.prepareArguments`, quando presente.
4. Valida os argumentos preparados com `Check` de `typebox/value`.
5. Reserva os limites da execução.
6. Chama `provider.preflight` com `NestedContext` completo.
7. Verifica novamente provider, atividade, disponibilidade, capabilities e schema.
8. Chama `provider.invoke` e devolve seu resultado sem extrair ou remodelar campos.

Erros do provider também são propagados intactos pela API direta do registry.

### Políticas

- no máximo 64 chamadas aceitas por `executionId`;
- no máximo 8 chamadas simultâneas por `executionId`;
- uma ferramenta com `parallel: false` executa com exclusividade;
- `interactive: true` é rejeitado;
- `nested: true` e `cancellable: true` são obrigatórios;
- `approval: true` é permitido, mas o provider deve decidir no `preflight`;
- a própria ferramenta `repl_notebook` é rejeitada para impedir recursão.

O bridge passa o mesmo `AbortSignal` de `BridgeExecution` ao provider. Ele não usa `Promise.race` para simular cancelamento. Se a ferramenta ignorar o sinal, ela continua pendente. `closeExecution` bloqueia somente novas chamadas: uma chamada já aceita, inclusive em `preflight`, ainda pode concluir normalmente. Use `settle()` para confirmar a limpeza. Se o sinal for abortado durante `preflight`, a chamada não entra em `invoke`.

## BridgeServer

```ts
const server = new BridgeServer(registry, maxBytes?);
const { url, token } = await server.start();

server.open(execution);
server.closeExecution(execution.identity.executionId);
await server.shutdown();
```

O construtor não abre sockets. `start()` cria sob demanda um servidor HTTP em `127.0.0.1`, porta aleatória, e retorna uma URL terminada em `/bridge` e um token aleatório. Chamadas repetidas enquanto ativo retornam as mesmas credenciais.

`open()` registra a identidade corrente. `closeExecution()` remove essa identidade e fecha o registry para novas chamadas. O dono da execução deve abortar seu `AbortController` quando desejar cancelamento; o server recebe apenas o `AbortSignal`.

`shutdown()` é idempotente. Ele fecha as execuções, conexões ociosas e, após uma janela limitada, conexões HTTP restantes. Ferramentas não cooperativas continuam rastreadas no registry até realmente terminarem.

## Protocolo HTTP v1

Envie `POST` para a URL retornada com:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

Todo corpo contém a identidade completa no nível superior:

```json
{
  "version": 1,
  "type": "hello",
  "requestId": "request-1",
  "sessionId": "session-1",
  "executionId": "execution-1",
  "cellId": "cell-1",
  "mode": "notebook",
  "generation": "generation-1"
}
```

Tipos de mensagem:

- `hello`: negocia a versão e libera essa identidade para as próximas mensagens.
- `tools`: retorna `registry.list(mode)` após o handshake.
- `call`: exige `name` e aceita `args`; retorna o resultado completo de `registry.invoke`.

Cada mensagem deve corresponder exatamente a `sessionId`, `executionId`, `cellId`, `mode` e `generation` registrados por `open()`. Identidade removida, antiga ou parcialmente diferente é rejeitada.

Resposta de sucesso:

```json
{"version":1,"requestId":"request-1","ok":true,"value":{}}
```

Resposta de erro:

```json
{"version":1,"requestId":"request-1","ok":false,"error":"mensagem"}
```

O servidor limita a 8 requisições HTTP simultâneas. Request e response têm o mesmo limite configurável, limitado a no máximo 1 MiB. A leitura do body tem timeout próprio (5 s por padrão): um body autenticado que nunca termina responde `408` e libera o slot de concorrência. Autenticação inválida retorna `401`, body incompleto que estoura o tempo retorna `408`, excesso de concorrência ou de chamadas retorna `429`, payload ou resposta grande retorna `413`, identidade stale ou execução encerrada retorna `409`, tool desconhecida/inativa retorna `404`, tool não permitida retorna `403`, erros de protocolo/validação retornam `400`, e falhas internas da tool retornam `500`. Quando o próprio `requestId` impedir uma resposta dentro do limite, o erro `413` usa `requestId` vazio. Se o cliente desconectar durante uma chamada, a resposta órfã é descartada após a conclusão cooperativa no registry. O `shutdown` aguarda o settle das execuções e a drenagem das requisições até o grace antes de fechar os sockets.
