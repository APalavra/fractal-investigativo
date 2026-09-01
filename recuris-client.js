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
    setStatus(`✓ Backend conectado. Memória evolutiva v${data.memory_version}.`, true);
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

function buildSafeHypothesis(micro) {
  const title = String(micro.titulo || micro.id || "microalvo").trim();
  return `Hipótese operacional para ${micro.id}: ${title} pode ser decomposto em uma afirmação específica e verificável por evidências explícitas.`;
}


function syncSafeActionButton() {
  const btn = $("btnEvoAplicarSeguro");
  if (!btn) return;
  const rec = lastAutomaticCycle?.decision?.recommendation;
  btn.disabled = !(rec && rec.category === "decomposicao");
  btn.title = btn.disabled
    ? "Disponível quando houver uma decisão pendente segura de decomposição."
    : "Aplicar a decisão pendente de decomposição.";
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

async function applySafeRecommendedAction() {
  const panel = $("evoSafeActionPanel");
  try {
    const cycle = lastAutomaticCycle;
    if (!cycle?.decision?.recommendation) {
      throw new Error("Execute primeiro o ciclo automático para obter uma decisão atual.");
    }

    const rec = cycle.decision.recommendation;
    if (rec.category !== "decomposicao") {
      panel.innerHTML = `
        <div class="card">
          <strong>Ação automática bloqueada por segurança epistemológica</strong>
          <p>A categoria atual é <strong>${esc(rec.category || "-")}</strong>.</p>
          <p>O protótipo não inventará fontes, não resolverá contradições e não elevará confiança automaticamente. Essas ações exigem julgamento humano.</p>
        </div>`;
      setStatus("✓ Nenhuma alteração automática inadequada foi feita.", true);
      return;
    }

    const db = loadWholeDB();
    const inv = db.ativa;
    const micro = pickDecompositionTarget(inv);
    if (!micro) throw new Error("Nenhum microalvo ativo disponível para decomposição.");

    const text = buildSafeHypothesis(micro);

    const duplicate = (inv.claims || []).some(c =>
      c.microalvoId === micro.id &&
      String(c.texto || "").trim().toLowerCase() === text.toLowerCase()
    );
    if (duplicate) {
      panel.innerHTML = `<div class="card"><strong>Nenhuma alteração feita.</strong><p>Essa hipótese automática já existe para ${esc(micro.id)}.</p></div>`;
      setStatus("✓ Duplicação evitada.", true);
      return;
    }

    if (!confirm(
      `Aplicar uma decomposição segura em ${micro.id}?\n\n` +
      `Será criado apenas um claim H pendente, confiança 30%, sem apagar nem validar nada automaticamente.`
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
      confianca: 30,
      criadoEm: now,
      atualizadoEm: now,
      geradoAutomaticamente: true,
      origemAutomatica: cycle.decision.decision_id || null
    });

    saveWholeDB(db);
    if ($("btnEvoAplicarSeguro")) $("btnEvoAplicarSeguro").disabled = true;

    try {
      await request("/memory/action-execution", {
        method: "POST",
        body: JSON.stringify({
          decision_id: cycle.decision.decision_id,
          action: {
            type: "create_claim",
            claim_id: id,
            microalvo_id: micro.id,
            generated_at: now
          }
        }),
      });
    } catch (err) {
      console.warn("Falha ao registrar evidência causal no backend:", err);
    }

    panel.innerHTML = `
      <div class="card">
        <strong>Alteração segura aplicada</strong>
        <p>${esc(id)} foi criado e ligado a ${esc(micro.id)}.</p>
        <div class="meta">Tipo H · pendente · confiança 30% · nenhuma fonte inventada · nenhuma conclusão validada automaticamente.</div><div class="meta">A execução foi registrada para avaliação causal no próximo ciclo.</div>
        <p>A página será recarregada para sincronizar toda a interface.</p>
      </div>`;
    setStatus(`✓ ${id} criado com rastreabilidade automática.`, true);

    setTimeout(() => location.reload(), 1200);
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
