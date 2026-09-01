const DB_KEY = "fractal_investigativo_v1_alpha";
const BACKEND_KEY = "fractal_backend_url";
const DEFAULT_BACKEND_URL = "https://fractal-investigativo.onrender.com";
let lastAnalysis = null;
let lastAutomaticCycle = null;

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function backendUrl() {
  return ($("evoBackendUrl")?.value || localStorage.getItem(BACKEND_KEY) || DEFAULT_BACKEND_URL).trim().replace(/\/$/, "");
}

function setStatus(text, ok = false) {
  const el = $("evoStatus");
  if (!el) return;
  el.textContent = text;
  el.dataset.ok = ok ? "1" : "0";
}

function loadInvestigation() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error("Memória v1.0-alpha não encontrada neste navegador.");
  const db = JSON.parse(raw);
  if (!db.ativa) throw new Error("Não há investigação ativa.");
  return db.ativa;
}

async function request(path, options = {}) {
  const base = backendUrl();
  if (!base) throw new Error("Informe primeiro a URL HTTPS do backend.");
  const res = await fetch(`${base}${path}`, {
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.message || `HTTP ${res.status}`);
  return data;
}

async function testBackend() {
  try {
    const url = backendUrl();
    if (!url) throw new Error("Informe a URL do backend.");
    localStorage.setItem(BACKEND_KEY, url);
    setStatus("Testando conexão...");
    const data = await request("/health");
    await restorePendingDecision();
    const pending = lastAutomaticCycle?.decision?.decision_id;
    setStatus(
      pending
        ? `✓ Backend conectado. Memória evolutiva v${data.memory_version}. Decisão pendente ${pending} restaurada.`
        : `✓ Backend conectado. Memória evolutiva v${data.memory_version}. Nenhuma decisão pendente.`,
      true
    );
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}

function renderAnalysis(data) {
  lastAnalysis = data;
  const out = $("evoResultado");
  if (!out) return;
  const validationById = Object.fromEntries((data.validations || []).map(v => [v.proposal_id, v]));
  out.innerHTML = `
    <div class="item">
      <strong>${esc(data.engine)}</strong>
      <div class="meta">Hash: ${esc(data.input_hash?.slice(0, 16))}…</div>
      <h3>Diagnóstico</h3>
      ${(data.diagnostics || []).map(x => `<p>• ${esc(x)}</p>`).join("") || "<p>Nenhum diagnóstico.</p>"}
    </div>
    ${(data.proposals || []).map(p => {
      const v = validationById[p.id];
      const recommended = p.id === data.recommended_proposal_id;
      return `<div class="item">
        <strong>${esc(p.id)} — ${esc(p.title)}${recommended ? " ★ recomendada" : ""}</strong>
        <p><b>Ação:</b> ${esc(p.action)}</p>
        <p><b>Razão:</b> ${esc(p.rationale)}</p>
        <div class="meta">Categoria: ${esc(p.category)} · confiança: ${esc(p.confidence)}% · validação: ${v?.accepted ? "aceita" : "rejeitada"}</div>
        <div class="row">
          <button class="secondary evoCommit" data-id="${esc(p.id)}" ${v?.accepted ? "" : "disabled"}>Registrar na memória evolutiva</button>
        </div>
        <div class="meta evoCommitMsg" data-msg-for="${esc(p.id)}"></div>
      </div>`;
    }).join("")}
  `;
  out.querySelectorAll(".evoCommit").forEach(btn => btn.addEventListener("click", () => commitProposal(btn.dataset.id)));
}

async function analyzeCurrent() {
  try {
    const url = backendUrl();
    if (!url) throw new Error("Informe a URL HTTPS do backend.");
    localStorage.setItem(BACKEND_KEY, url);
    const investigation = loadInvestigation();
    setStatus("Analisando investigação atual...");
    const data = await request("/analyze", {
      method: "POST",
      body: JSON.stringify({
        investigation,
        context: {frontend: "fractal-v1.0-alpha", mode: "deterministic"},
      }),
    });
    renderAnalysis(data);
    setStatus(`✓ Análise concluída. ${data.proposals?.length || 0} proposta(s).`, true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}

async function commitProposal(id) {
  const escCss = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  const button = document.querySelector(`.evoCommit[data-id="${escCss}"]`);
  const inline = document.querySelector(`.evoCommitMsg[data-msg-for="${escCss}"]`);

  try {
    if (!lastAnalysis) throw new Error("Execute uma análise primeiro.");
    const investigation = loadInvestigation();
    const proposal = lastAnalysis.proposals.find(x => x.id === id);
    const validation = lastAnalysis.validations.find(x => x.proposal_id === id);
    if (!proposal || !validation) throw new Error("Proposta ou validação não encontrada.");
    if (!confirm(`Registrar ${id} na memória evolutiva do backend?`)) return;

    if (button) {
      button.disabled = true;
      button.textContent = "Registrando...";
    }
    if (inline) inline.textContent = "Registrando no backend...";
    setStatus(`Registrando ${id}...`);

    const data = await request("/memory/commit", {
      method: "POST",
      body: JSON.stringify({investigation, proposal, validation}),
    });

    if (data.committed) {
      const msg = `✓ REGISTRADO COM SUCESSO: ${data.entry_id}. Memória evolutiva v${data.memory_version}.`;
      if (button) button.textContent = "✓ Registrado";
      if (inline) {
        inline.textContent = msg;
        inline.style.fontWeight = "700";
      }
      setStatus(msg, true);
      alert(msg);
      return;
    }

    if (data.duplicate || /já foi registrada/i.test(data.message || "")) {
      const msg = `✓ JÁ ESTAVA REGISTRADO. A memória não foi duplicada e continua em v${data.memory_version}.`;
      if (button) button.textContent = "✓ Já registrado";
      if (inline) {
        inline.textContent = msg;
        inline.style.fontWeight = "700";
      }
      setStatus(msg, true);
      alert(msg);
      return;
    }

    if (button) {
      button.disabled = false;
      button.textContent = "Registrar na memória evolutiva";
    }
    if (inline) inline.textContent = `✗ ${data.message}`;
    setStatus(`✗ ${data.message}`);
    alert(`Falha ao registrar: ${data.message}`);
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = "Registrar na memória evolutiva";
    }
    if (inline) inline.textContent = `✗ ${err.message}`;
    setStatus(`✗ ${err.message}`);
    alert(`Falha ao registrar: ${err.message}`);
  }
}


async function showMemorySummary() {
  try {
    setStatus("Consultando memória evolutiva...");
    const data = await request("/memory/summary");
    const target = $("evoMemoryPanel");
    const cats = Object.entries(data.by_category || {})
      .map(([k,v]) => `${esc(k)}: ${v}`)
      .join(" · ") || "nenhuma categoria";

    const latest = (data.latest || []).map(e => `
      <div class="card compact">
        <strong>${esc(e.id || "MEM")}</strong> — ${esc(e.title || e.proposal_id || "registro")}
        <div class="meta">${esc(e.category || "—")} · ${esc(e.created_at || "")}</div>
      </div>
    `).join("");

    target.innerHTML = `
      <div class="card">
        <strong>Memória evolutiva persistente</strong>
        <div class="meta">PostgreSQL · versão v${data.version} · ${data.total_entries} registro(s)</div>
        <div class="meta">${cats}</div>
      </div>
      ${latest || '<div class="meta">Nenhum registro ainda.</div>'}
    `;
    setStatus(`✓ Memória consultada. ${data.total_entries} registro(s) persistente(s).`, true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}


async function compareWithMemory() {
  try {
    setStatus("Comparando investigação atual com ciclos anteriores...");
    const investigation = loadInvestigation();
    const data = await request("/memory/compare", {
      method: "POST",
      body: JSON.stringify({ investigation }),
    });

    const target = $("evoComparePanel");
    const cats = Object.entries(data.prior_categories || {})
      .map(([k,v]) => `${esc(k)}: ${v}`)
      .join(" · ") || "nenhuma";

    const guidance = (data.guidance || [])
      .map(x => `<li>${esc(x)}</li>`)
      .join("");

    const repeated = (data.repeated_targets || []).length
      ? esc(data.repeated_targets.join(", "))
      : "nenhum";

    target.innerHTML = `
      <div class="card">
        <strong>Comparação com ciclos anteriores</strong>
        <div class="meta">Memória v${data.memory_version} · correspondências exatas do estado atual: ${data.exact_state_matches}</div>
        <div class="meta">Categorias históricas: ${cats}</div>
        <div class="meta">Alvos recorrentes: ${repeated}</div>
        ${guidance ? `<ul>${guidance}</ul>` : ""}
      </div>
    `;

    setStatus("✓ Comparação histórica concluída.", true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}






function loadWholeDB() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error("Memória local do Fractal não encontrada.");
  const db = JSON.parse(raw);
  if (!db.ativa) throw new Error("Não há investigação ativa.");
  return db;
}

function saveWholeDB(db) {
  if (db.ativa) db.ativa.atualizadoEm = new Date().toISOString();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function nextClaimId(inv) {
  inv.counters = inv.counters || {};
  let n = Number(inv.counters.claim || 1);
  const used = new Set((inv.claims || []).map(c => c.id));
  while (used.has(`CLM-${n}`)) n += 1;
  inv.counters.claim = n + 1;
  return `CLM-${n}`;
}

function pickDecompositionTarget(inv) {
  const active = (inv.microNos || []).filter(m =>
    ["aberto", "investigando"].includes(m.estado)
  );
  if (!active.length) return null;

  const claimCount = id => (inv.claims || []).filter(c => c.microalvoId === id).length;
  const depth = id => String(id || "").split(".").length;

  active.sort((a, b) => {
    const aNoClaim = claimCount(a.id) === 0 ? 0 : 1;
    const bNoClaim = claimCount(b.id) === 0 ? 0 : 1;
    return aNoClaim - bNoClaim
      || depth(a.id) - depth(b.id)
      || String(a.id).localeCompare(String(b.id), undefined, {numeric:true});
  });
  return active[0];
}

function buildSafeDraft(micro) {
  const title = String(micro.titulo || micro.id || "microalvo").trim();
  return `[RASCUNHO ESTRUTURAL — preencher manualmente] Microalvo ${micro.id}: ${title}. Escreva aqui uma hipótese específica e verificável; nenhuma afirmação factual foi criada automaticamente.`;
}



function cleanClaimText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function priorityScore(inv, micro) {
  const w = inv?.configPrioridade || {
    aberto:10, investigando:7, bloqueado:-30,
    dependenciaPendente:-25, porDependente:5,
    porDesbloqueio:4, semClaims:3, porContestado:2
  };

  let score = 0;
  const parts = [];
  const add = (value, label) => {
    const n = Number(value || 0);
    if (n) { score += n; parts.push(`${label}: ${n >= 0 ? "+" : ""}${n}`); }
  };

  if (micro.estado === "aberto") add(w.aberto, "aberto");
  if (micro.estado === "investigando") add(w.investigando, "investigando");
  if (micro.estado === "bloqueado") add(w.bloqueado, "bloqueado");

  const relMicro = Array.isArray(inv?.relacoesMicro) ? inv.relacoesMicro : [];
  const byId = Object.fromEntries((inv?.microNos || []).map(m => [m.id, m]));

  const pendingDeps = relMicro.filter(r =>
    r.origem === micro.id &&
    r.tipo === "depende" &&
    !["concluido","resolvido","fechado"].includes(String(byId[r.destino]?.estado || "").toLowerCase())
  ).length;
  if (pendingDeps) add(Number(w.dependenciaPendente || 0) * pendingDeps, `${pendingDeps} dependência(s) pendente(s)`);

  const dependents = relMicro.filter(r => r.destino === micro.id && r.tipo === "depende").length;
  if (dependents) add(Number(w.porDependente || 0) * dependents, `${dependents} dependente(s)`);

  const unlocks = relMicro.filter(r => r.origem === micro.id && r.tipo === "desbloqueia").length;
  if (unlocks) add(Number(w.porDesbloqueio || 0) * unlocks, `${unlocks} desbloqueio(s)`);

  const linkedClaims = (inv?.claims || []).filter(c => c.microalvoId === micro.id);
  if (!linkedClaims.length) add(w.semClaims, "sem claims");

  const contestedIds = new Set(
    (inv?.relacoes || [])
      .filter(r => r.estado === "contestada")
      .flatMap(r => [r.origem, r.destino])
  );
  const contested = linkedClaims.filter(c => contestedIds.has(c.id) || c.estado === "contestada").length;
  if (contested) add(Number(w.porContestado || 0) * contested, `${contested} claim(s) contestado(s)`);

  return { score, parts };
}

function pickPriorityTarget(inv) {
  const active = (inv?.microNos || []).filter(m =>
    ["aberto", "investigando"].includes(String(m.estado || "").toLowerCase())
  );
  if (!active.length) return null;

  return active
    .map(m => ({ micro:m, ...priorityScore(inv, m) }))
    .sort((a,b) =>
      b.score - a.score ||
      String(a.micro.id).localeCompare(String(b.micro.id), undefined, {numeric:true})
    )[0];
}

function semanticRelationStatus(relation) {
  const raw = String(relation?.validacaoSemantica || relation?.statusSemantico || "nao_avaliada").trim().toLowerCase();
  const aliases = {
    "real":"contradicao_real",
    "confirmada":"contradicao_real",
    "contradicao":"contradicao_real",
    "contradição_real":"contradicao_real",
    "tensão":"tensao",
    "contestacao":"tensao",
    "contestação":"tensao",
    "compatível":"compativel",
    "compativeis":"compativel",
    "compatíveis":"compativel",
    "nao_avaliado":"nao_avaliada",
    "não_avaliada":"nao_avaliada",
    "não_avaliado":"nao_avaliada"
  };
  return aliases[raw] || raw;
}

function contradictionPairs(inv, { onlyConfirmed = false, onlyUnreviewed = false } = {}) {
  const claims = Object.fromEntries((inv?.claims || []).map(c => [c.id, c]));
  return (inv?.relacoes || [])
    .filter(r => r.tipo === "contradiz")
    .filter(r => {
      const status = semanticRelationStatus(r);
      if (onlyConfirmed) return status === "contradicao_real";
      if (onlyUnreviewed) return status === "nao_avaliada";
      return true;
    })
    .map(r => ({
      relation:r,
      semanticStatus: semanticRelationStatus(r),
      left:claims[r.origem] || null,
      right:claims[r.destino] || null
    }));
}

function semanticStatusLabel(status) {
  return ({
    contradicao_real:"contradição real confirmada",
    tensao:"tensão/contestação",
    compativel:"compatíveis",
    nao_avaliada:"não avaliada"
  })[status] || status || "não avaliada";
}

function sourceCountForClaim(inv, claimId) {
  return (inv?.fonteClaims || []).filter(x => x.claimId === claimId).length;
}

async function recordSafeExecution(decisionId, action) {
  try {
    await request("/memory/action-execution", {
      method: "POST",
      body: JSON.stringify({ decision_id: decisionId, action }),
    });
  } catch (err) {
    console.warn("Falha ao registrar evidência causal no backend:", err);
  }
}

async function reconcileDecisionIfObsolete(decisionId, inv) {
  if (!decisionId) return null;
  try {
    return await request("/memory/reconcile-decision", {
      method: "POST",
      body: JSON.stringify({ decision_id: decisionId, investigation: inv }),
    });
  } catch (err) {
    console.warn("Falha ao reconciliar decisão pendente:", err);
    return null;
  }
}

function syncSafeActionButton() {
  const btn = $("btnEvoAplicarSeguro");
  if (!btn) return;
  const rec = lastAutomaticCycle?.decision?.recommendation;

  // v19: nunca deixar o botão "morto".
  // Se o estado local estiver vazio, o próprio clique consulta o backend.
  btn.disabled = false;

  if (!rec) {
    btn.title = "Consultar a decisão pendente no backend e aplicar somente se for seguro.";
  } else if (["decomposicao","prioridade"].includes(rec.category)) {
    btn.title = "Aplicar somente a parte operacional segura desta decisão.";
  } else if (["evidencia","contradicao","qualidade"].includes(rec.category)) {
    btn.title = "Abrir orientação segura ou revisão humana sem decidir fatos automaticamente.";
  } else {
    btn.title = "Ver a justificativa de segurança para esta recomendação.";
  }
}

async function restorePendingDecision() {
  try {
    const data = await request("/memory/pending-decision", { method: "GET" });
    if (data?.found && data.decision) {
      lastAutomaticCycle = {
        decision_created: false,
        decision: data.decision,
        message: "Decisão pendente restaurada do backend."
      };
    }
  } catch (err) {
    console.warn("Não foi possível restaurar a decisão pendente:", err);
  } finally {
    syncSafeActionButton();
  }
}

async function refreshPendingDecisionFromBackend() {
  const data = await request("/memory/pending-decision", { method: "GET" });

  if (data?.found && data.decision) {
    lastAutomaticCycle = {
      decision_created: false,
      decision: data.decision,
      message: "Decisão pendente sincronizada diretamente do backend."
    };
    syncSafeActionButton();
    return data.decision;
  }

  lastAutomaticCycle = null;
  syncSafeActionButton();
  return null;
}


function claimsWithoutSources(inv) {
  const claims = Array.isArray(inv?.claims) ? inv.claims : [];
  const links = Array.isArray(inv?.fonteClaims) ? inv.fonteClaims : [];
  const linked = new Set(links.map(x => x.claimId).filter(Boolean));
  return claims.filter(c => c?.id && !linked.has(c.id));
}

async function applySafeRecommendedAction() {
  const panel = $("evoSafeActionPanel");
  try {
    setStatus("Sincronizando decisão pendente com o backend...");

    if (!lastAutomaticCycle?.decision?.recommendation) {
      await refreshPendingDecisionFromBackend();
    }

    const cycle = lastAutomaticCycle;
    if (!cycle?.decision?.recommendation) {
      panel.innerHTML = `
        <div class="card">
          <strong>Nenhuma decisão pendente encontrada</strong>
          <p>O backend foi consultado diretamente e não retornou uma decisão operacional pendente.</p>
          <p>Execute um novo ciclo automático apenas quando quiser gerar a próxima decisão.</p>
        </div>`;
      setStatus("✓ Backend consultado; nenhuma decisão pendente disponível.", true);
      return;
    }

    const rec = cycle.decision.recommendation;
    const decisionId = cycle.decision.decision_id || null;

    if (rec.category === "evidencia") {
      const inv = loadInvestigation();
      const missing = claimsWithoutSources(inv);
      let operational = "";

      if (missing.length) {
        const items = missing.map(c => {
          const text = cleanClaimText(c.texto);
          const short = text.length > 120 ? text.slice(0, 117) + "..." : text;
          return `<li><strong>${esc(c.id)}</strong>${short ? ` — ${esc(short)}` : ""}</li>`;
        }).join("");

        operational = `
          <div class="card">
            <strong>Claims sem rastreabilidade detectados: ${missing.length}</strong>
            <ul>${items}</ul>
            <p><strong>Próxima ação humana:</strong> adicione ou selecione uma fonte real na seção 5 e vincule-a ao claim desejado na seção 6.</p>
          </div>`;
      } else {
        const reconciled = await reconcileDecisionIfObsolete(decisionId, inv);
        if (reconciled?.reconciled || reconciled?.status === "already_closed") {
          lastAutomaticCycle = null;
          syncSafeActionButton();
          operational = `
            <div class="card">
              <strong>Nenhum claim sem fonte foi encontrado localmente.</strong>
              <p><strong>${esc(decisionId || "Decisão")}</strong> foi reconciliada e encerrada porque a recomendação já não possui gatilho real no estado atual.</p>
              <p>Agora execute um novo ciclo automático para obter uma decisão realmente aplicável.</p>
            </div>`;
        } else {
          operational = `
            <div class="card">
              <strong>Nenhum claim sem fonte foi encontrado localmente.</strong>
              <p>O backend não encerrou automaticamente a decisão; nenhuma alteração epistemológica foi feita.</p>
            </div>`;
        }
      }

      panel.innerHTML = `
        <div class="card">
          <strong>Ação automática bloqueada com segurança</strong>
          <p>A categoria atual é <strong>evidencia</strong>.</p>
          <p>A recomendação exige uma fonte real. O sistema não inventará referências nem criará evidência fictícia.</p>
          <p><strong>Nenhuma alteração epistemológica foi feita.</strong></p>
        </div>
        ${operational}`;
      setStatus("✓ Evidência: automação recusada com segurança; orientação operacional exibida.", true);
      return;
    }

    if (rec.category === "qualidade") {
      const db = loadWholeDB();
      const inv = db.ativa;
      const pairs = contradictionPairs(inv, { onlyUnreviewed: true });

      if (!pairs.length) {
        const reconciled = await reconcileDecisionIfObsolete(decisionId, inv);
        if (reconciled?.reconciled || reconciled?.status === "already_closed") {
          lastAutomaticCycle = null;
          syncSafeActionButton();
        }
        panel.innerHTML = `
          <div class="card">
            <strong>Nenhuma relação 'contradiz' aguarda revisão semântica</strong>
            <p>O estado local não possui relação não avaliada.</p>
            <p>${reconciled?.reconciled ? `${esc(decisionId || "A decisão")} foi reconciliada e encerrada como obsoleta.` : "Nenhuma alteração epistemológica foi feita."}</p>
          </div>`;
        setStatus("✓ Qualidade: nenhuma relação pendente; decisão reconciliada quando aplicável.", true);
        return;
      }

      const items = pairs.map(({relation,left,right}) => {
        const lt = cleanClaimText(left?.texto);
        const rt = cleanClaimText(right?.texto);
        return `
          <div class="card semantic-review" data-relation-id="${esc(relation.id)}">
            <strong>${esc(relation.id)} — ${esc(relation.origem)} contradiz ${esc(relation.destino)}</strong>
            <p><b>${esc(relation.origem)}</b>: ${esc(lt || "claim não encontrado")}</p>
            <div class="meta">Fontes ligadas: ${sourceCountForClaim(inv, relation.origem)}</div>
            <p><b>${esc(relation.destino)}</b>: ${esc(rt || "claim não encontrado")}</p>
            <div class="meta">Fontes ligadas: ${sourceCountForClaim(inv, relation.destino)}</div>
            <p><strong>Classificação humana:</strong> escolha apenas depois de comparar condições, escopo e significado das duas proposições.</p>
            <div class="meta"><b>Contradição real:</b> as duas proposições não podem ser verdadeiras ao mesmo tempo sob as mesmas condições.</div>
            <div class="meta"><b>Tensão/contestação:</b> há conflito aparente ou dependente de interpretação/condições.</div>
            <div class="meta"><b>Compatíveis:</b> as duas proposições podem ser verdadeiras simultaneamente; o vínculo 'contradiz' foi semanticamente inadequado.</div>
            <div class="row">
              <button type="button" class="secondary semanticChoice" data-status="contradicao_real">Contradição real</button>
              <button type="button" class="secondary semanticChoice" data-status="tensao">Tensão/contestação</button>
              <button type="button" class="secondary semanticChoice" data-status="compativel">Compatíveis</button>
            </div>
            <div class="meta semanticChoiceMsg"></div>
          </div>`;
      }).join("");

      panel.innerHTML = `
        <div class="card">
          <strong>Validação semântica humana de relações</strong>
          <p>Foram encontradas ${pairs.length} relação(ões) 'contradiz' que ainda não foram semanticamente avaliadas.</p>
          <p><strong>O sistema não classificará nenhuma delas sozinho.</strong> A escolha abaixo registra apenas a sua revisão humana.</p>
        </div>
        ${items}`;

      panel.querySelectorAll(".semanticChoice").forEach(button => {
        button.addEventListener("click", async () => {
          const card = button.closest(".semantic-review");
          const relationId = card?.dataset?.relationId;
          const status = button.dataset.status;
          const relation = (inv.relacoes || []).find(r => r.id === relationId);
          if (!relation) return;

          const label = semanticStatusLabel(status);
          if (!confirm(
            `Registrar ${relationId} como “${label}”?

` +
            `Essa classificação foi escolhida por você. O sistema não está decidindo qual claim é verdadeiro.`
          )) return;

          const now = new Date().toISOString();
          relation.validacaoSemantica = status;
          relation.revisaoSemantica = {
            status,
            origem: "revisao_humana",
            decisionId,
            revisadoEm: now
          };
          relation.atualizadoEm = now;

          saveWholeDB(db);
          window.dispatchEvent(new CustomEvent("fractal:external-db-update", { detail: { db } }));

          await recordSafeExecution(decisionId, {
            type: "classify_relation_semantics",
            relation_id: relationId,
            semantic_status: status,
            human_selected: true,
            generated_at: now
          });

          card.querySelectorAll(".semanticChoice").forEach(b => b.disabled = true);
          const msg = card.querySelector(".semanticChoiceMsg");
          if (msg) msg.textContent = `✓ ${relationId}: ${label}. Classificação humana registrada.`;
          setStatus(`✓ ${relationId} recebeu revisão semântica humana: ${label}.`, true);
        });
      });
      setStatus("✓ Relações não avaliadas exibidas para classificação humana; nenhuma decisão automática de verdade foi feita.", true);
      return;
    }

    if (rec.category === "contradicao") {
      const inv = loadInvestigation();
      const pairs = contradictionPairs(inv, { onlyConfirmed: true });

      if (!pairs.length) {
        const reconciled = await reconcileDecisionIfObsolete(decisionId, inv);
        if (reconciled?.reconciled || reconciled?.status === "already_closed") {
          lastAutomaticCycle = null;
          syncSafeActionButton();
        }
        panel.innerHTML = `
          <div class="card">
            <strong>Nenhuma contradição semanticamente confirmada encontrada</strong>
            <p>O estado local não contém relação <strong>contradiz</strong> validada por uma pessoa como <strong>contradição real</strong>.</p>
            <p>${reconciled?.reconciled ? `${esc(decisionId || "A decisão")} foi reconciliada e encerrada; o próximo ciclo poderá escolher outra necessidade.` : "Nenhuma alteração epistemológica foi feita."}</p>
          </div>`;
        setStatus("✓ Contradição: nenhuma resolução automática; decisão reconciliada quando obsoleta.", true);
        return;
      }

      const items = pairs.map(({relation,left,right}) => {
        const lt = cleanClaimText(left?.texto);
        const rt = cleanClaimText(right?.texto);
        return `
          <div class="card">
            <strong>${esc(relation.id)} — ${esc(relation.origem)} contradiz ${esc(relation.destino)}</strong>
            <p><b>${esc(relation.origem)}</b>: ${esc(lt || "claim não encontrado")}</p>
            <div class="meta">Fontes ligadas: ${sourceCountForClaim(inv, relation.origem)}</div>
            <p><b>${esc(relation.destino)}</b>: ${esc(rt || "claim não encontrado")}</p>
            <div class="meta">Fontes ligadas: ${sourceCountForClaim(inv, relation.destino)}</div>
            <p><strong>Revisão humana:</strong> compare definições, condições, escopo e evidências de cada lado. Não marque vencedor sem evidência explícita.</p>
          </div>`;
      }).join("");

      panel.innerHTML = `
        <div class="card">
          <strong>Checklist seguro de contradição</strong>
          <p>Foram encontradas ${pairs.length} contradição(ões) semanticamente confirmada(s) por revisão humana.</p>
          <p><strong>O sistema não resolveu nenhuma delas automaticamente.</strong></p>
        </div>
        ${items}`;
      setStatus("✓ Contradição mapeada; decisão de verdade preservada para revisão baseada em evidências.", true);
      return;
    }

    if (rec.category === "prioridade") {
      const db = loadWholeDB();
      const inv = db.ativa;
      const picked = pickPriorityTarget(inv);
      if (!picked) throw new Error("Nenhum microalvo ativo disponível para priorização.");

      const micro = picked.micro;
      const scoreText = `${picked.score} ponto(s)`;
      const parts = picked.parts.length ? picked.parts.join(" · ") : "sem componentes adicionais";

      if (!confirm(
        `Focar operacionalmente ${micro.id}?\n\n` +
        `Score estrutural: ${scoreText}.\n` +
        `Isso NÃO altera nenhum claim, fonte, relação epistemológica ou confiança.`
      )) return;

      const previousState = micro.estado;
      if (String(micro.estado).toLowerCase() === "aberto") {
        micro.estado = "investigando";
        micro.atualizadoEm = new Date().toISOString();
      }

      inv.focoEvolutivo = {
        microalvoId: micro.id,
        decisionId,
        score: picked.score,
        selecionadoEm: new Date().toISOString()
      };

      saveWholeDB(db);
      window.dispatchEvent(new CustomEvent("fractal:external-db-update", { detail: { db } }));

      await recordSafeExecution(decisionId, {
        type: "focus_microtarget",
        microalvo_id: micro.id,
        previous_state: previousState,
        new_state: micro.estado,
        priority_score: picked.score,
        generated_at: new Date().toISOString()
      });

      panel.innerHTML = `
        <div class="card">
          <strong>Foco operacional aplicado com segurança</strong>
          <p><strong>${esc(micro.id)}</strong> — ${esc(micro.titulo || "")}</p>
          <div class="meta">Score: ${esc(scoreText)} · ${esc(parts)}</div>
          <div class="meta">Estado: ${esc(previousState)} → ${esc(micro.estado)}</div>
          <p>Nenhum claim, fonte, confiança ou relação de verdade foi modificado.</p>
        </div>`;
      setStatus(`✓ Prioridade operacional focada em ${micro.id}, sem alterar conteúdo epistemológico.`, true);
      return;
    }

    if (rec.category === "decomposicao") {
      const db = loadWholeDB();
      const inv = db.ativa;
      const micro = pickDecompositionTarget(inv);
      if (!micro) throw new Error("Nenhum microalvo ativo disponível para decomposição.");

      const text = buildSafeDraft(micro);
      const duplicate = (inv.claims || []).some(c =>
        c.microalvoId === micro.id &&
        String(c.texto || "").trim().toLowerCase() === text.toLowerCase()
      );

      if (duplicate) {
        panel.innerHTML = `<div class="card"><strong>Nenhuma alteração feita.</strong><p>Esse rascunho estrutural já existe para ${esc(micro.id)}.</p></div>`;
        setStatus("✓ Duplicação de rascunho evitada.", true);
        return;
      }

      if (!confirm(
        `Aplicar uma decomposição segura em ${micro.id}?\n\n` +
        `Será criado apenas um claim H pendente e estrutural, confiança 0%, sem inventar fatos, apagar ou validar nada automaticamente.`
      )) return;

      inv.claims = inv.claims || [];
      const id = nextClaimId(inv);
      const now = new Date().toISOString();
      inv.claims.push({
        id,
        texto: text,
        tipo: "H",
        estado: "pendente",
        microalvoId: micro.id,
        confianca: 0,
        criadoEm: now,
        atualizadoEm: now,
        geradoAutomaticamente: true,
        rascunhoEstrutural: true,
        origemAutomatica: decisionId
      });

      saveWholeDB(db);
      window.dispatchEvent(new CustomEvent("fractal:external-db-update", { detail: { db } }));
      if ($("btnEvoAplicarSeguro")) $("btnEvoAplicarSeguro").disabled = true;

      await recordSafeExecution(decisionId, {
        type: "create_structural_draft",
        claim_id: id,
        microalvo_id: micro.id,
        confidence: 0,
        generated_at: now
      });

      panel.innerHTML = `
        <div class="card">
          <strong>Alteração segura aplicada</strong>
          <p>${esc(id)} foi criado e ligado a ${esc(micro.id)}.</p>
          <div class="meta">Tipo H · pendente · confiança 0% · rascunho estrutural · nenhum fato ou fonte inventados · nenhuma conclusão validada automaticamente.</div>
          <div class="meta">A execução foi registrada para avaliação causal no próximo ciclo.</div>
          <p>O claim já foi sincronizado com a investigação atual.</p>
        </div>`;
      setStatus(`✓ ${id} criado como rascunho estrutural 0% e registrado causalmente.`, true);
      return;
    }

    panel.innerHTML = `
      <div class="card">
        <strong>Categoria ainda sem executor seguro</strong>
        <p>Categoria recebida: <strong>${esc(rec.category || "-")}</strong>.</p>
        <p>Nenhuma alteração foi feita.</p>
      </div>`;
    setStatus("✓ Categoria desconhecida recusada com segurança.", true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}

async function runAutomaticCycle() {
  const button = $("btnEvoCiclo");
  try {
    button.disabled = true;
    button.textContent = "Executando ciclo...";
    setStatus("Executando ciclo automático completo...");

    const investigation = loadInvestigation();
    const data = await request("/memory/cycle", {
      method: "POST",
      body: JSON.stringify({ investigation }),
    });
    lastAutomaticCycle = data;
    syncSafeActionButton();

    const target = $("evoCyclePanel");
    const decision = data.decision || {};
    const rec = decision.recommendation || {};
    const outcome = data.outcome || null;

    const scores = (decision.adaptive_scores || []).map(x =>
      `<div class="meta"><strong>${esc(x.category)}</strong>: ${esc(x.score)}</div>`
    ).join("");

    const rationale = (decision.rationale || []).map(x => `<li>${esc(x)}</li>`).join("");
    const historical = (data.comparison?.guidance || []).map(x => `<li>${esc(x)}</li>`).join("");
    const deltaNotes = (data.delta?.interpretation || []).map(x => `<li>${esc(x)}</li>`).join("");

    const outcomeHtml = outcome ? `
      <div class="card">
        <strong>Resultado anterior avaliado automaticamente</strong>
        <div class="meta">${esc(outcome.decision_id)} · ${esc(outcome.outcome_label)} · score ${esc(outcome.outcome_score)}</div>
      </div>
    ` : `
      <div class="meta">Nenhum resultado anterior precisou ser avaliado neste ciclo.</div>
    `;

    target.innerHTML = `
      <div class="card">
        <strong>Ciclo automático</strong>
        <div class="meta">${esc(data.message)}</div>
        <div class="meta">Memória evolutiva v${esc(data.memory_version)}</div>
        ${outcomeHtml}
        <div class="card">
          <strong>${data.decision_created ? "Nova decisão" : "Decisão pendente preservada"}</strong>
          <div class="meta">${esc(decision.decision_id || "-")}</div>
          <div class="meta">Categoria: <strong>${esc(rec.category || "-")}</strong> · score ${esc(rec.score ?? "-")}</div>
          <p><strong>Próxima ação:</strong> ${esc(rec.action || "-")}</p>
          ${scores}
        </div>
        ${historical ? `<div><strong>Histórico</strong><ul>${historical}</ul></div>` : ""}
        ${deltaNotes ? `<div><strong>Δ</strong><ul>${deltaNotes}</ul></div>` : ""}
        ${rationale ? `<div><strong>Justificativa</strong><ul>${rationale}</ul></div>` : ""}
      </div>
    `;

    setStatus("✓ Ciclo automático concluído.", true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Executar ciclo automático";
  }
}

async function evaluateLastDecision() {
  try {
    setStatus("Avaliando resultado da última decisão adaptativa...");
    const investigation = loadInvestigation();
    const data = await request("/memory/outcome", {
      method: "POST",
      body: JSON.stringify({ investigation }),
    });

    const target = $("evoOutcomePanel");
    const delta = Object.entries(data.changes || {})
      .map(([k,v]) => `<div class="meta">${esc(k)}: ${v >= 0 ? "+" : ""}${v}</div>`)
      .join("");
    const notes = (data.notes || []).map(x => `<li>${esc(x)}</li>`).join("");

    target.innerHTML = `
      <div class="card">
        <strong>Aprendizado por resultado</strong>
        <div class="meta">Decisão avaliada: ${esc(data.decision_id)}</div>
        <div class="meta">Resultado: <strong>${esc(data.outcome_label)}</strong> · score ${esc(data.outcome_score)}</div>
        <p><strong>Recomendação avaliada:</strong> ${esc(data.recommendation?.action || "-")}</p>
        ${delta}
        ${notes ? `<ul>${notes}</ul>` : ""}
      </div>
    `;

    setStatus(`✓ Resultado avaliado: ${data.outcome_label}.`, true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}

async function runAdaptiveDecision() {
  try {
    setStatus("Executando ciclo adaptativo: memória + Δ + estado atual...");
    const investigation = loadInvestigation();
    const data = await request("/memory/adaptive", {
      method: "POST",
      body: JSON.stringify({ investigation, save_snapshot: true }),
    });

    const target = $("evoAdaptivePanel");
    const scores = (data.adaptive_scores || []).map(x => `
      <div class="meta"><strong>${esc(x.category)}</strong>: ${esc(x.score)}</div>
    `).join("");

    const rationale = (data.rationale || []).map(x => `<li>${esc(x)}</li>`).join("");
    const rec = data.recommendation || {};

    target.innerHTML = `
      <div class="card">
        <strong>Decisão adaptativa</strong>
        <div class="meta">Decisão: ${esc(data.decision_id || "-")} · Memórias consultadas: ${esc(data.memory_records)}</div>
        <div class="meta">Categoria escolhida: <strong>${esc(rec.category || "-")}</strong></div>
        <div class="meta">Score: ${esc(rec.score ?? "-")}</div>
        <p><strong>Próxima ação:</strong> ${esc(rec.action || "-")}</p>
        <div class="card">${scores}</div>
        ${rationale ? `<ul>${rationale}</ul>` : ""}
      </div>
    `;
    setStatus("✓ Decisão adaptativa concluída.", true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}

async function measureDelta() {
  try {
    setStatus("Medindo evolução temporal Δ...");
    const investigation = loadInvestigation();
    const data = await request("/memory/delta", {
      method: "POST",
      body: JSON.stringify({ investigation, save_snapshot: true }),
    });

    const target = $("evoDeltaPanel");
    const d = data.changes?.delta || {};
    const metrics = Object.entries(d)
      .map(([k,v]) => `<div class="meta">${esc(k)}: ${v >= 0 ? "+" : ""}${v}</div>`)
      .join("");

    const notes = (data.interpretation || [])
      .map(x => `<li>${esc(x)}</li>`)
      .join("");

    target.innerHTML = `
      <div class="card">
        <strong>Evolução temporal Δ</strong>
        <div class="meta">Linha de base anterior: ${data.baseline_found ? esc(data.baseline_snapshot_id || "sim") : "não havia"}</div>
        <div class="meta">Novo snapshot: ${esc(data.saved_snapshot_id || "estado já idêntico ao último")}</div>
        ${metrics || '<div class="meta">Sem delta numérico ainda.</div>'}
        ${notes ? `<ul>${notes}</ul>` : ""}
      </div>
    `;

    setStatus("✓ Evolução temporal Δ calculada.", true);
  } catch (err) {
    setStatus(`✗ ${err.message}`);
  }
}

function init() {
  const input = $("evoBackendUrl");
  if (!input) return;
  input.value = localStorage.getItem(BACKEND_KEY) || DEFAULT_BACKEND_URL;
  $("btnEvoTestar").addEventListener("click", testBackend);
  $("btnEvoAnalisar").addEventListener("click", analyzeCurrent);
  $("btnEvoMemoria").addEventListener("click", showMemorySummary);
  $("btnEvoComparar").addEventListener("click", compareWithMemory);
  $("btnEvoDelta").addEventListener("click", measureDelta);
  $("btnEvoAdaptativo").addEventListener("click", runAdaptiveDecision);
  $("btnEvoResultado").addEventListener("click", evaluateLastDecision);
  $("btnEvoCiclo").addEventListener("click", runAutomaticCycle);
  $("btnEvoAplicarSeguro").addEventListener("click", applySafeRecommendedAction);
  syncSafeActionButton();
  restorePendingDecision();
  setStatus(input.value ? "Backend configurado; teste a conexão." : "Backend ainda não configurado.");
}

init();
