# FRACTAL N2 — REGISTRO DE DÍVIDA

Qualquer simplificação temporária que reduza robustez, generalidade ou independência deve ser registrada aqui.

### DEBT-001 — Dependência de modelo
- Data: 2026-09-02
- Pilar(es): G
- Simplificação: primeira integração pode usar inicialmente um único fornecedor/modelo.
- Motivo: velocidade.
- Risco: dependência de fornecedor.
- Bloqueia N2? Não necessariamente, desde que a arquitetura preserve possibilidade real de troca.
- Critério para quitar: abstração de provider/model e teste de substituição.
- Status: aberta

### DEBT-002 — Memória fotográfica ainda não implementada
- Data: 2026-09-02
- Pilar(es): H
- Simplificação: o protótipo atual possui persistência, mas ainda não satisfaz integralmente o arquivo histórico canônico definido na Constituição.
- Motivo: arquitetura anterior antecede a definição completa de H.
- Risco: perda, compactação ou recuperação incompleta.
- Bloqueia N2? Sim.
- Critério para quitar: event log append-only, versionado, íntegro, pesquisável e testado.
- Status: aberta
