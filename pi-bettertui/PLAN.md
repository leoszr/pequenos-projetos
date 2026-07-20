# pi-bettertui — Plano de Desenvolvimento

**Objetivo:** Extensão de TUI minimalista e polida para o pi coding agent (v0.80+), com suporte robusto a temas claros e escuros, integração dinâmica com o Omarchy e footer completo.

---

## Contexto e Motivações

### O que é pi-pane?
O repositório original [`visua1hue/pi-pane`](https://github.com/visua1hue/pi-pane) é uma extensão de TUI que oferecia:
- Header animado com logo e seções de startup em colunas
- Verificação de versão local vs. npm latest
- Editor emoldurado com prefixo `π` e fundo de painel
- Tempo de resposta por mensagem
- Quit guard (duplo Ctrl+C para sair)
- Supressão elegante de flash de startup

**Problema:** O pi-pane foi desenvolvido para pi **≤ v0.67.68** usando a biblioteca antiga `@mariozechner/pi-coding-agent`. Seu código depende de monkey-patches frágeis (intercepta `console.log`, suprime `process.stdout.write`, patcheia `UserMessageComponent.prototype.render`), que **quebram completamente** na v0.80+ (`@earendil-works/pi-coding-agent`).

### Por que não funciona em temas claros?
Mesmo quando rodava, o pi-pane tinha 4 problemas de cor:

1. **Fade do logo hardcoded para fundo escuro** — animação vai de cinza 50 → branco 255, invisível em fundo claro
2. **Fade-in das seções começa de `rgb(20,20,20)`** — em fundo claro simula visibilidade errada
3. **Fallbacks escuros** — painel `#101010`, texto `#4a4a4a`
4. **Animações não derivam da luminância do tema ativo** — não se adaptam a dark/light/custom

### Por que reescrever em vez de consertar?
- **Compatibilidade:** a API oficial v0.80 (`setHeader`, `setFooter`, `setEditorComponent`) substitui todos os monkey-patches
- **Resiliência:** a extensão sobrevive a upgrades do pi sem manutenção
- **Integração Omarchy:** a v0.80 permite hot-reload de tema; a nova extensão precisa de reatividade completa

---

## Princípios de Design

1. **Zero cores hardcoded.** Toda cor vem dos 51 tokens semânticos do tema ativo via `theme.fg()`, `theme.bg()`, `theme.bold()`.

2. **Padrão "rebuild on invalidate"** para troca de tema ao vivo. Quando o pi chama `invalidate()` em troca de tema (ex.: Omarchy em tempo real), componentes rebuild com cores novas — não apenas cache limpo.

3. **Luminância-aware desde o scaffold.** Animações do logo interpolam entre a **cor de fundo real do tema** (extraída do token `userMessageBg` via `theme.bg()`) e a cor-alvo (ex.: accent). Em fundo claro, logo escurece; em fundo escuro, clareia.

4. **API oficial exclusively.** `setHeader`, `setFooter`, `setEditorComponent`, `setWorkingIndicator`, `setStatus` — nada de monkey-patch ou internals.

5. **Graceful degradation.** Sem truecolor (`COLORTERM` vazio), sem animação — cor estática via tokens. Sem Omarchy na máquina, tudo ainda funciona com o tema pi ativo.

---

## Cronograma: 7 Fases

### Fase 1: Scaffold + Fundação de Cor (`palette.ts`)

**Objetivo:** Módulo central de resolução de cores theme-aware.

**Delíveis:**
- `src/index.ts` — entry point, wiring de eventos (`session_start`, `session_shutdown`), ciclo de vida
- `src/palette.ts` — kernel de cor:
  - `detectLuminance(theme: Theme): "light" | "dark"` — detecta modo do tema extraindo RGB de `theme.bg("userMessageBg")` e calculando luminância (fórmula padrão WCAG)
  - `resolvePalette(theme: Theme): PanePalette` — mapeia tokens semânticos (`borderMuted`, `dim`, `muted`, `accent`) para funções wrappers (ex.: `frame(text)`, `hint(text)`)
  - `getAnimationEndpoints(theme: Theme, luminance: "light" | "dark"): { bgStart, fgEnd }` — endpoints de animação: em tema claro, fade parte do branco; em escuro, do preto. Consulta `light.mode` do Omarchy se existir, fallback para cálculo de RGB
  - Tipos: `interface PanePalette { frame, prefix, time, hint, panelBg, panelEdge }`
- `tsconfig.json`, `package.json` (ESM, @earendil-works/pi-coding-agent + pi-tui como peer/dev)

**Stack:**
```
src/
├── index.ts              # entry + ciclo de vida
├── palette.ts            # resolução de cores + luminância
├── header.ts             # (stub)
├── editor.ts             # (stub)
├── footer.ts             # (stub)
└── indicator.ts          # (stub)
```

**Dev:** `pi -e ./src/index.ts` ou configurar no settings.

---

### Fase 2: Footer Completo (`footer.ts`)

**Objetivo:** Barra de rodapé informativa com git, tokens, contexto e timing.

**Delíveis:**
- `src/footer.ts` — via `ctx.ui.setFooter()`:
  - **Esquerda:** cwd abreviado (`~/.config/...`), branch git (via `footerData.getGitBranch()`), contagem de arquivos modificados (`git status --porcelain`)
  - **Direita:** 
    - Modelo ativo (`ctx.model?.id`)
    - Nível de thinking (`ctx.thinking ?? "off"`)
    - Tokens de entrada/saída (`↑input_tokens ↓output_tokens`)
    - Custo total (`$USD`)
    - **% contexto usado** com mini-barra visual (8 segmentos: `░░░░░░░░`)
    - **Tempo da última resposta** (medido em ms/s via `turn_start`/`turn_end`)
  - Incluir `footerData.getExtensionStatuses()` — não engolir status de outras extensões
  - Cores: `dim`/`muted` no corpo, `warning` acima de 70%, `error` acima de 90% contexto
  - Padrão rebuild-on-invalidate com `onBranchChange()` reactive

**Cálculos:**
- % contexto = `(input + output) / (ctx.model?.maxInputTokens ?? 200000)` 
- Último tempo = armazenar em `responseTimes: number[][]` no closure, indexado por message ID
- Mini-barra: mapear % para índice em `['░', '▒', '▒', '▒', '▒', '▒', '▒', '█']`

**Dev:** `pi` → digitar prompt → verificar footer com animação de % de contexto.

---

### Fase 3: Editor Emoldurado (`editor.ts`)

**Objetivo:** Classe customizada estendendo `CustomEditor` com moldura, quit guard e prefixo.

**Delíveis:**
- `src/editor.ts` — `class PiPaneEditor extends CustomEditor`:
  - Moldura: `┌─┐` top, `└─┘` bottom, com cor via `palette.frame()`
  - Prefixo: `π` (ou `  pi `) colorido via `palette.prefix()`
  - Fundo de painel via `theme.bg("userMessageBg")`
  - **Quit guard:** Ctrl+C com texto → limpa input; sem texto → mostra hint "`<Key> to quit`" por 500ms; segundo Ctrl+C dentro da janela → `ctx.shutdown()`
  - Hint desaparece ao digitar qualquer outra tecla
  - Autocomplete hints (`›`) alinhados dentro da moldura
  - Padrão rebuild-on-invalidate (moldura redesenhada ao trocar tema)

**API:**
```typescript
constructor(
  tui: TUI,
  editorTheme: EditorTheme,
  keybindings: KeybindingsManager,
  { getTheme, isIdle, shutdown }
)
```

**Dev:** `pi -e ./src/index.ts` → digitar `hello` → Ctrl+C (limpa) → Ctrl+C de novo (pede confirmação).

---

### Fase 4: Header Minimalista (`header.ts`)

**Objetivo:** Header compacto com logo animado e informações essenciais (sem colunas de startup).

**Delíveis:**
- `src/header.ts` — via `ctx.ui.setHeader()`:
  - **Logo:** matriz de 4 linhas `████...` com fade-in theme-aware:
    - Detecta luminância via `palette.ts`
    - Endpoints de animação: claro (branco → fg), escuro (preto → fg)
    - Frame 0–70: animação (22 frames fade, 70 frames settle), sem truecolor = estático
    - Interpolação RGB via `lerp()` se `COLORTERM` contiver `truecolor`/`24bit`
  - **Linha compacta:** `π v0.80.3 · corporate · /home/leo/Projects/pequenos-projetos/pi-bettertui`
  - **Checagem de versão:** fetch `https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest` com timeout 4s, mostra `local v0.80.3` vs `latest vX.Y.Z` (destacar em `accent` se há update)
  - Rebuild-on-invalidate
  - **Scope cortado propositalmente:** as colunas de startup (Models/Skills/Extensions/Themes) do pi-pane ficam de fora — dependem de parsear o container do chat por dentro, muito frágil. Se fizer falta, criamos `/bettertui info` sob demanda.

**Dev:** `pi -e ./src/index.ts` → observar header animar → trocar tema com omarchy-system-theme rodando.

---

### Fase 5: Integração com Tema do Omarchy

**Objetivo:** Dialogar com o Omarchy para detecção dinâmica de luminância e reatividade de tema.

**Sub-fase 5a: Gerador de tema luminância-aware** (conserta a fundação do Omarchy)
- Estender ou reescrever `~/.local/bin/omarchy-to-pi-theme` para:
  - Ler `~/.config/omarchy/current/theme/light.mode` (simples: existe = claro, ausente = escuro)
  - Fallback para luminância calculada do `background` se `light.mode` não existir
  - Derivar `accent`, `muted`, `dim`, `borderMuted` **em modo-específico**:
    - **Claro:** cores mais escuras, saturadas, altos contrastes
    - **Escuro:** cores mais claras, suaves, baixos contrastes contra bg escuro
  - Gerar `~/.pi/agent/themes/omarchy-current.json` como antes, mas com `meta.luminance` adicional
  - Integrar check de Omarchy direto na Fase 5b/5c

**Sub-fase 5b: Reação instantânea na extensão**
- Substituir ou melhorar `omarchy-system-theme.ts` (aposentar após aprovação):
  - `fs.watch()` em `~/.config/omarchy/current/theme.name`
  - Ao detectar mudança, chamar `ctx.ui.setTheme("omarchy-current")` + `tui.requestRender(true)`
  - Com rebuild-on-invalidate das Fases 1–4, tudo redesenha automaticamente

**Sub-fase 5c: Enriquecimento visual do Omarchy (opcional, degradável)**
- Quando Omarchy presente:
  - Ler `colors.toml` para `accent` real (ex.: `#005f87`), não apenas token genérico
  - Logo do header anima em direção ao accent do Omarchy
  - Footer exibe nome do tema ativo (ex.: `corporate`) para confirmação visual
  - Sem Omarchy? Tudo volta aos tokens do pi — extensão 100% funcional

**Dev:** Trocar tema no Omarchy no meio de uma sessão viva (claro→escuro→claro), observar header/editor/footer redesenharem sem reiniciar pi.

---

### Fase 6: Polimento (`indicator.ts`, comando `/bettertui`)

**Objetivo:** Detalhes finais e controle de extensão.

**Delíveis:**
- `src/indicator.ts` — working indicator sutil via `setWorkingIndicator()`:
  - Frames animados: `dim → muted → accent → muted` (ciclo suave)
  - Interval: 120–150ms
  - Restaurável: `ctx.ui.setWorkingIndicator()` volta ao padrão
- Comando `/bettertui`:
  - `/bettertui enable` — ativa tudo (header, footer, editor customizado)
  - `/bettertui disable` — restaura defaults (`setHeader(undefined)`, `setFooter(undefined)`, etc.)
  - `/bettertui status` — mostra qual parte está ativa (com cores da palette)
  - `/bettertui reload` — força rebuild de tudo (útil após troca de tema manual)
  - Armazena estado em `ctx.sessionManager` para persistir entre turns
- README.md com:
  - Features
  - Requisitos (pi v0.80+, truecolor)
  - Instalação (symlink em `~/.pi/agent/extensions/` ou settings.json)
  - FAQ (temas suportados, Omarchy, performance)
  - Licença (MIT)

---

### Fase 7: Verificação e Testes

**Objetivo:** Validar comportamento em cenários reais.

**Testes obrigatórios:**

1. **Tema escuro nativo do pi:**
   ```bash
   pi --theme dark -e ./src/index.ts
   ```
   - [ ] Header anima com logo clareia (preto → branco)
   - [ ] Editor moldura visível, prefixo `π` legível
   - [ ] Footer legível com cores dim/muted/accent
   - Enviar prompt longo → contexto % sobe → footer atualiza

2. **Tema claro nativo do pi:**
   ```bash
   pi --theme light -e ./src/index.ts
   ```
   - [ ] Header anima com logo escurece (branco → preto)
   - [ ] Editor moldura legível em fundo claro
   - [ ] Footer contrast adequado
   - Quit guard funciona: Ctrl+C limpa, segundo Ctrl+C pede confirmação

3. **Tema Omarchy (claro):**
   - Rodar a extensão com tema `omarchy-current` ativo
   - [ ] Header mostra `corporate` no canto (ou nome do tema ativo)
   - [ ] Logo anima em direção ao `#005f87` (blue do corporate)
   - [ ] Editor/footer respeitam `panelBg` do Omarchy

4. **Hot-swap de tema Omarchy:**
   - Extensão rodando com Omarchy `corporate` (claro)
   - [ ] Trocar para tema escuro no Omarchy (ex.: `nord`)
   - [ ] Sem reiniciar pi, header/editor/footer redesenham
   - [ ] Logo muda direção de animação
   - [ ] Footer cores ajustam
   - [ ] Trocar de volta para claro — mesmo comportamento reverso

5. **Sem truecolor:**
   ```bash
   COLORTERM= pi -e ./src/index.ts
   ```
   - [ ] Logo renderiza estático (cor única), sem fade
   - [ ] Resto da extensão não quebra, apenas sem animação

6. **Performance:**
   - Footer atualiza a cada turn sem travamento (<16ms render)
   - Header settle rápido (após frame 70, pra de animar)
   - Trocar de tema não causa lag

---

## Estrutura de Arquivos Final

```
pi-bettertui/
├── PLAN.md                    # este arquivo
├── README.md                  # features, install, FAQ
├── LICENSE                    # MIT
├── package.json               # ESM, deps mínimas
├── tsconfig.json
└── src/
    ├── index.ts               # entry, ciclo de vida, commands
    ├── palette.ts             # resolução de cores + luminância
    ├── header.ts              # logo animado + info
    ├── editor.ts              # PiPaneEditor customizado
    ├── footer.ts              # footer completo
    ├── indicator.ts           # working indicator
    └── utils.ts               # helpers (truncate, format, etc.)
```

**Tipos exportados de `palette.ts`:**
```typescript
export interface PanePalette {
  frame(text: string): string;
  prefix(text: string): string;
  time(text: string): string;
  hint(text: string): string;
  panelBg: string;
  panelEdge: string;
}

export type Luminance = "light" | "dark";

export function detectLuminance(theme: Theme): Luminance;
export function resolvePalette(theme: Theme): PanePalette;
export function getAnimationEndpoints(
  theme: Theme,
  luminance: Luminance
): { bgStart: [r, g, b], fgEnd: [r, g, b] };
```

---

## Riscos e Mitigações

| Risco | Impacto | Mitigação |
|-------|--------|-----------|
| `setFooter` substitui footer inteiro, perdendo info do padrão | Alto | Capturar output padrão com `footerData`, replicar antes de adicionar custom |
| Outras extensões mexem no editor → conflito com `setEditorComponent` | Médio | Documentar incompatibilidade, não bloquear (`setEditorComponent` = noop) |
| Omarchy não instalado → `fs.watch()` falha | Baixo | Try-catch em torno de `fs.watch()`, fallback para polling se necessário |
| Troca de tema ao vivo com rendering = race condition | Médio | Usar `invalidate()` callback + symbol-keyed state para sincronização |
| Performance animação RGB em terminal lento | Baixo | Disable truecolor ou frame skip se render passa de 16ms |
| npm fetch falha → timeout 4s bloqueia startup | Baixo | Async com `.then()` não-blocking, default para "unknown" se timeout |

---

## Próximas Ações

1. **Implementar Fase 1** (scaffold + palette.ts)
   - Setup tsconfig, package.json
   - Detectar luminância via RGB
   - Testes: dark/light nativo do pi

2. **Implementar Fase 2** (footer.ts)
   - Integrar `turn_start`/`turn_end`
   - Cálculos de tokens e contexto %
   - Testes: footer atualiza com input longo

3. **Implementar Fases 3–4** (editor, header)
   - CustomEditor + quit guard
   - Logo animado
   - Testes: quit guard funciona, logo anima

4. **Implementar Fase 5** (Omarchy)
   - Integração com `light.mode`
   - fs.watch() + rerender
   - Testes: hot-swap de tema

5. **Implementar Fase 6–7** (polimento, testes)
   - Comando `/bettertui`
   - Matriz de testes completa
   - Publicação em git

---

## Referências

- Docs oficial do pi v0.80+: `/home/leo/.local/share/mise/installs/node/22.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
- Script Omarchy: `/home/leo/.local/bin/omarchy-to-pi-theme`
- Código pi-pane original: `https://github.com/visua1hue/pi-pane`

---

**Início:** julho 2026  
**Status:** Em planejamento  
**Versão:** 1.0.0-alpha
