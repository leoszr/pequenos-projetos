# Autoridade, worktrees e segurança

O agente principal continua responsável pela correção final. A extensão
registra ownership e audita o resultado; ela não transforma prompts em sandbox.

## Modos

- `read_only`: restrição declarada no system prompt/brief e comparação de
  baseline Git após o turno;
- `controlled_mutation`: checkout compartilhado, paths declarados e diff
  auditado; o pai congela suas próprias edições conflitantes;
- `isolated_mutation`: worktree/branch própria, obrigatória para mutações
  concorrentes ou snapshot estável.

Não há bloqueio hardcoded de `write`, `edit` ou `bash`, pois outras extensões
podem converter as tools para Codex. Quando garantia forte de read-only for
necessária, forneça sandbox externo e marque essa precondition na delegação.

## Ownership

Defina base ref, paths editáveis, contratos somente leitura, evidências e
necessidade de commit. Nunca dê o mesmo arquivo central a dois executores
simultâneos. Reviewer recebe commit/diff estável e `reviewOf`.

A extensão registra pane, tab, workspace, worktree, branch, processo e
artefatos imediatamente após criação. Metadata Herdr contém delegation ID,
parent session e token de ownership. Recurso sem correspondência não é limpo.

## Validação

- pesquisa: confira claims/fontes;
- mudança pequena: diff e checks focados;
- implementação: diff, testes, status e comportamento;
- alto risco: review independente e evidência reproduzível.

Side effects read-only, paths fora do ownership e paths proibidos aparecem na
auditoria de `holistic_inspect`. Resumo do filho não basta.

## Cleanup

Antes de `holistic_manage close|cleanup`:

1. preserve commits, patches, logs e artefatos úteis;
2. integre ou descarte conscientemente a branch;
3. confirme worktree limpa;
4. deixe a extensão validar metadata e remover em ordem segura.

Cleanup é idempotente, não usa force por padrão e para diante de worktree suja,
branch não removível ou ownership divergente. `accepted` não significa
automaticamente “integrado”.
