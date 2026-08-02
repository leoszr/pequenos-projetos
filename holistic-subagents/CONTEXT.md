# Glossário do domínio

## Política de Modelos

Conjunto configurável de regras que transforma a capacidade e o esforço pedidos
para uma delegação em um modelo e um perfil de raciocínio elegíveis. Define
modelos permitidos, padrões, restrições, fallback degradado e finalidade de
execução ou verificação. Seus valores podem ser alterados sem mudar a
implementação do produto.

## Política Efetiva

Política de Modelos aplicada à sessão atual. Uma política definida pelo projeto
substitui integralmente a política global; na ausência dela, vale a política
global. Configuração de projeto só participa quando o projeto é confiável.

## Agent Session

Ambiente auxiliar durável que mantém identidade, contexto conversacional, CWD
físico, workspace, topologia, recursos, escopo de confiança, teto de autoridade e modelo. Executa
no máximo uma Delegation Run por vez e pode permanecer aquecida entre missões.

## Delegation Run

Missão limitada atribuída a uma Agent Session. Reúne objetivo, autoridade,
critérios, perguntas, correções e evidências até terminar como aceita, falha ou
cancelada. Um novo objetivo depois do término constitui uma nova Run.
Só pode usar uma Agent Session cujo CWD físico e ambiente sejam compatíveis com
os pedidos da missão.

## Contexto limpo

Agent Session recém-criada, sem missões anteriores. Resumir ou compactar uma
sessão existente não produz contexto limpo.

## Teto de Autoridade

Autoridade máxima imutável de uma Agent Session. Toda Run nela executada deve
ter autoridade contida nesse teto.

## Escopo de Confiança

Identidade do âmbito confiável no qual uma Agent Session pode ser reutilizada.
Reuso exige igualdade exata de escopo.
