# Fractal Investigativo v1.0-alpha

Arquitetura consolidada para GitHub Pages.

## Estrutura

- `index.html` — interface
- `css/style.css` — estilos
- `js/storage.js` — localStorage, exportação e limpeza
- `js/model.js` — modelo de dados, migração, prioridade e verificador
- `js/ui.js` — utilidades de interface
- `js/app.js` — controle da aplicação

## Migração

A v1.0-alpha procura primeiro `fractal_investigativo_v1_alpha`.
Se não existir, tenta migrar automaticamente, nesta ordem:

1. v0.8
2. v0.7
3. v0.6
4. v0.5
5. v0.4
6. v0.3
7. v0.2
8. chave legada `fractal_memoria`

As chaves antigas não são apagadas.

## Importante

Este projeto ainda é 100% frontend e funciona no GitHub Pages.
O backend Python/Recuris deverá ser integrado posteriormente por uma API/servidor.
Não coloque chaves privadas de API neste repositório público.
