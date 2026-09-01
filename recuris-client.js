```
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
  if (!raw) throw new Error("MemÃ³ria v1.0-alpha nÃ£o encontrada neste navegador.");
  const db = JSON.parse(raw);
  if (!db.ativa) throw new Error("NÃ£o hÃ¡ investigaÃ§Ã£o ativa.");
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
    setStatus("Testando conexÃ£o...");
    const data = await request("/health");
    await restorePendingDecision();
    const pending = lastAutomaticCycle?.decision?.decision_id;
    setStatus(
      pending
        ? `âœ“ Backend conectado. MemÃ³ria evolutiva v${data.memory_version}. DecisÃ£o pendente ${pending} restaurada.`
        : `âœ“ Backend conectado. MemÃ³ria evolutiva v${data.memory_version}. Nenhuma decisÃ£o pendente.`,
      true
    );
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
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
      <div class="meta">Hash: ${esc(data.input_hash?.slice(0, 16))}â€¦</div>
      <h3>DiagnÃ³stico</h3>
      ${(data.diagnostics || []).map(x => `<p>â€¢ ${esc(x)}</p>`).join("") || "<p>Nenhum diagnÃ³stico.</p>"}
    </div>
    ${(data.proposals || []).map(p => {
      const v = validationById[p.id];
      const recommended = p.id === data.recommended_proposal_id;
      return `<div class="item">
        <strong>${esc(p.id)} â€” ${esc(p.title)}${recommended ? " â˜… recomendada" : ""}</strong>
        <p><b>AÃ§Ã£o:</b> ${esc(p.action)}</p>
        <p><b>RazÃ£o:</b> ${esc(p.rationale)}</p>
        <div class="meta">Categoria: ${esc(p.category)} Â· confianÃ§a: ${esc(p.confidence)}% Â· validaÃ§Ã£o: ${v?.accepted ? "aceita" : "rejeitada"}</div>
        <div class="row">
          <button class="secondary evoCommit" data-id="${esc(p.id)}" ${v?.accepted ? "" : "disabled"}>Registrar na memÃ³ria evolutiva</button>
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
    setStatus("Analisando investigaÃ§Ã£o atual...");
    const data = await request("/analyze", {
      method: "POST",
      body: JSON.stringify({
        investigation,
        context: {frontend: "fractal-v1.0-alpha", mode: "deterministic"},
      }),
    });
    renderAnalysis(data);
    setStatus(`âœ“ AnÃ¡lise concluÃ­da. ${data.proposals?.length || 0} proposta(s).`, true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  }
}

async function commitProposal(id) {
  const escCss = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  const button = document.querySelector(`.evoCommit[data-id="${escCss}"]`);
  const inline = document.querySelector(`.evoCommitMsg[data-msg-for="${escCss}"]`);

  try {
    if (!lastAnalysis) throw new Error("Execute uma anÃ¡lise primeiro.");
    const investigation = loadInvestigation();
    const proposal = lastAnalysis.proposals.find(x => x.id === id);
    const validation = lastAnalysis.validations.find(x => x.proposal_id === id);
    if (!proposal || !validation) throw new Error("Proposta ou validaÃ§Ã£o nÃ£o encontrada.");
    if (!confirm(`Registrar ${id} na memÃ³ria evolutiva do backend?`)) return;

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
      const msg = `âœ“ REGISTRADO COM SUCESSO: ${data.entry_id}. MemÃ³ria evolutiva v${data.memory_version}.`;
      if (button) button.textContent = "âœ“ Registrado";
      if (inline) {
        inline.textContent = msg;
        inline.style.fontWeight = "700";
      }
      setStatus(msg, true);
      alert(msg);
      return;
    }

    if (data.duplicate || /jÃ¡ foi registrada/i.test(data.message || "")) {
      const msg = `âœ“ JÃ ESTAVA REGISTRADO. A memÃ³ria nÃ£o foi duplicada e continua em v${data.memory_version}.`;
      if (button) button.textContent = "âœ“ JÃ¡ registrado";
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
      button.textContent = "Registrar na memÃ³ria evolutiva";
    }
    if (inline) inline.textContent = `âœ— ${data.message}`;
    setStatus(`âœ— ${data.message}`);
    alert(`Falha ao registrar: ${data.message}`);
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = "Registrar na memÃ³ria evolutiva";
    }
    if (inline) inline.textContent = `âœ— ${err.message}`;
    setStatus(`âœ— ${err.message}`);
    alert(`Falha ao registrar: ${err.message}`);
  }
}


async function showMemorySummary() {
  try {
    setStatus("Consultando memÃ³ria evolutiva...");
    const data = await request("/memory/summary");
    const target = $("evoMemoryPanel");
    const cats = Object.entries(data.by_category || {})
      .map(([k,v]) => `${esc(k)}: ${v}`)
      .join(" Â· ") || "nenhuma categoria";

    const latest = (data.latest || []).map(e => `
      <div class="card compact">
        <strong>${esc(e.id || "MEM")}</strong> â€” ${esc(e.title || e.proposal_id || "registro")}
        <div class="meta">${esc(e.category || "â€”")} Â· ${esc(e.created_at || "")}</div>
      </div>
    `).join("");

    target.innerHTML = `
      <div class="card">
        <strong>MemÃ³ria evolutiva persistente</strong>
        <div class="meta">PostgreSQL Â· versÃ£o v${data.version} Â· ${data.total_entries} registro(s)</div>
        <div class="meta">${cats}</div>
      </div>
      ${latest || '<div class="meta">Nenhum registro ainda.</div>'}
    `;
    setStatus(`âœ“ MemÃ³ria consultada. ${data.total_entries} registro(s) persistente(s).`, true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  }
}


async function compareWithMemory() {
  try {
    setStatus("Comparando investigaÃ§Ã£o atual com ciclos anteriores...");
    const investigation = loadInvestigation();
    const data = await request("/memory/compare", {
      method: "POST",
      body: JSON.stringify({ investigation }),
    });

    const target = $("evoComparePanel");
    const cats = Object.entries(data.prior_categories || {})
      .map(([k,v]) => `${esc(k)}: ${v}`)
      .join(" Â· ") || "nenhuma";

    const guidance = (data.guidance || [])
      .map(x => `<li>${esc(x)}</li>`)
      .join("");

    const repeated = (data.repeated_targets || []).length
      ? esc(data.repeated_targets.join(", "))
      : "nenhum";

    target.innerHTML = `
      <div class="card">
        <strong>ComparaÃ§Ã£o com ciclos anteriores</strong>
        <div class="meta">MemÃ³ria v${data.memory_version} Â· correspondÃªncias exatas do estado atual: ${data.exact_state_matches}</div>
        <div class="meta">Categorias histÃ³ricas: ${cats}</div>
        <div class="meta">Alvos recorrentes: ${repeated}</div>
        ${guidance ? `<ul>${guidance}</ul>` : ""}
      </div>
    `;

    setStatus("âœ“ ComparaÃ§Ã£o histÃ³rica concluÃ­da.", true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  }
}






function loadWholeDB() {
  const raw = localStorage.getItem(DB_KEY);
  if (!raw) throw new Error("MemÃ³ria local do Fractal nÃ£o encontrada.");
  const db = JSON.parse(raw);
  if (!db.ativa) throw new Error("NÃ£o hÃ¡ investigaÃ§Ã£o ativa.");
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
  return `HipÃ³tese operacional para ${micro.id}: ${title} pode ser decomposto em uma afirmaÃ§Ã£o especÃ­fica e verificÃ¡vel por evidÃªncias explÃ­citas.`;
}


function syncSafeActionButton() {
  const btn = $("btnEvoAplicarSeguro");
  if (!btn) return;
  const rec = lastAutomaticCycle?.decision?.recommendation;

  // v19: nunca deixar o botÃ£o "morto".
  // Se o estado local estiver vazio, o prÃ³prio clique consulta o backend.
  btn.disabled = false;

  if (!rec) {
    btn.title = "Consultar a decisÃ£o pendente no backend e aplicar somente se for seguro.";
  } else if (rec.category === "decomposicao") {
    btn.title = "Aplicar a decisÃ£o pendente de decomposiÃ§Ã£o.";
  } else {
    btn.title = "Ver a justificativa de seguranÃ§a para esta recomendaÃ§Ã£o.";
  }
}

async function restorePendingDecision() {
  try {
    const data = await request("/memory/pending-decision", { method: "GET" });
    if (data?.found && data.decision) {
      lastAutomaticCycle = {
        decision_created: false,
        decision: data.decision,
        message: "DecisÃ£o pendente restaurada do backend."
      };
    }
  } catch (err) {
    console.warn("NÃ£o foi possÃ­vel restaurar a decisÃ£o pendente:", err);
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
      message: "DecisÃ£o pendente sincronizada diretamente do backend."
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
    setStatus("Sincronizando decisÃ£o pendente com o backend...");

    if (!lastAutomaticCycle?.decision?.recommendation) {
      await refreshPendingDecisionFromBackend();
    }

    const cycle = lastAutomaticCycle;
    if (!cycle?.decision?.recommendation) {
      panel.innerHTML = `
        <div class="card">
          <strong>Nenhuma decisÃ£o pendente encontrada</strong>
          <p>O backend foi consultado diretamente e nÃ£o retornou uma decisÃ£o operacional pendente.</p>
          <p>Execute um novo ciclo automÃ¡tico apenas quando quiser gerar a prÃ³xima decisÃ£o.</p>
        </div>`;
      setStatus("âœ“ Backend consultado; nenhuma decisÃ£o pendente disponÃ­vel.", true);
      return;
    }

    const rec = cycle.decision.recommendation;
    if (rec.category !== "decomposicao") {
      let detail = "O protÃ³tipo nÃ£o resolverÃ¡ contradiÃ§Ãµes nem elevarÃ¡ confianÃ§a automaticamente. Essas aÃ§Ãµes exigem julgamento humano.";
      let operational = "";

      if (rec.category === "evidencia") {
        const inv = loadInvestigation();
        const missing = claimsWithoutSources(inv);

        detail = "A recomendaÃ§Ã£o exige uma fonte real. O sistema nÃ£o inventarÃ¡ referÃªncias nem criarÃ¡ evidÃªncia fictÃ­cia.";

        if (missing.length) {
          const items = missing.map(c => {
            const text = String(c.texto || "").replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
            const short = text.length > 120 ? text.slice(0, 117) + "..." : text;
            return `<li><strong>${esc(c.id)}</strong>${short ? ` â€” ${esc(short)}` : ""}</li>`;
          }).join("");

          operational = `
            <div class="card">
              <strong>Claims sem rastreabilidade detectados: ${missing.length}</strong>
              <ul>${items}</ul>
              <p><strong>PrÃ³xima aÃ§Ã£o humana:</strong> adicione ou selecione uma fonte real na seÃ§Ã£o 5 e vincule-a ao claim desejado na seÃ§Ã£o 6.</p>
            </div>`;
        } else {
          operational = `
            <div class="card">
              <strong>Nenhum claim sem fonte foi encontrado localmente.</strong>
              <p>Reexecute o ciclo automÃ¡tico para recalcular a decisÃ£o com o estado atual.</p>
            </div>`;
        }
      }

      panel.innerHTML = `
        <div class="card">
          <strong>AÃ§Ã£o automÃ¡tica bloqueada com seguranÃ§a</strong>
          <p>A categoria atual Ã© <strong>${esc(rec.category || "-")}</strong>.</p>
          <p>${esc(detail)}</p>
          <p><strong>Nenhuma alteraÃ§Ã£o foi feita na investigaÃ§Ã£o.</strong></p>
        </div>
        ${operational}`;
      setStatus("âœ“ AÃ§Ã£o automÃ¡tica recusada com seguranÃ§a; orientaÃ§Ã£o operacional exibida.", true);
      return;
    }

    const db = loadWholeDB();
    const inv = db.ativa;
    const micro = pickDecompositionTarget(inv);
    if (!micro) throw new Error("Nenhum microalvo ativo disponÃ­vel para decomposiÃ§Ã£o.");

    const text = buildSafeDraft(micro);

    const duplicate = (inv.claims || []).some(c =>
      c.microalvoId === micro.id &&
      String(c.texto || "").trim().toLowerCase() === text.toLowerCase()
    );
    if (duplicate) {
      panel.innerHTML = `<div class="card"><strong>Nenhuma alteraÃ§Ã£o feita.</strong><p>Essa hipÃ³tese automÃ¡tica jÃ¡ existe para ${esc(micro.id)}.</p></div>`;
      setStatus("âœ“ DuplicaÃ§Ã£o evitada.", true);
      return;
    }

    if (!confirm(
      `Aplicar uma decomposiÃ§Ã£o segura em ${micro.id}?\n\n` +
      `SerÃ¡ criado apenas um claim H pendente e estrutural, confianÃ§a 0%, sem inventar fatos, apagar ou validar nada automaticamente.`
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
      origemAutomatica: cycle.decision.decision_id || null
    });

    // Atualiza o banco persistente e tambÃ©m o estado em memÃ³ria do app.js.
    // Isso evita que o beforeunload do app.js regrave uma cÃ³pia antiga e apague o claim recÃ©m-criado.
    saveWholeDB(db);
    window.dispatchEvent(new CustomEvent("fractal:external-db-update", {
      detail: { db }
    }));
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
      console.warn("Falha ao registrar evidÃªncia causal no backend:", err);
    }

    panel.innerHTML = `
      <div class="card">
        <strong>AlteraÃ§Ã£o segura aplicada</strong>
        <p>${esc(id)} foi criado e ligado a ${esc(micro.id)}.</p>
        <div class="meta">Tipo H Â· pendente Â· confianÃ§a 0% Â· rascunho estrutural Â· nenhum fato ou fonte inventados Â· nenhuma conclusÃ£o validada automaticamente.</div>
        <div class="meta">A execuÃ§Ã£o foi registrada para avaliaÃ§Ã£o causal no prÃ³ximo ciclo.</div>
        <p>O claim jÃ¡ foi sincronizado com a investigaÃ§Ã£o atual.</p>
      </div>`;
    setStatus(`âœ“ ${id} criado, sincronizado e registrado causalmente.`, true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  }
}

async function runAutomaticCycle() {
  const button = $("btnEvoCiclo");
  try {
    button.disabled = true;
    button.textContent = "Executando ciclo...";
    setStatus("Executando ciclo automÃ¡tico completo...");

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
        <div class="meta">${esc(outcome.decision_id)} Â· ${esc(outcome.outcome_label)} Â· score ${esc(outcome.outcome_score)}</div>
      </div>
    ` : `
      <div class="meta">Nenhum resultado anterior precisou ser avaliado neste ciclo.</div>
    `;

    target.innerHTML = `
      <div class="card">
        <strong>Ciclo automÃ¡tico</strong>
        <div class="meta">${esc(data.message)}</div>
        <div class="meta">MemÃ³ria evolutiva v${esc(data.memory_version)}</div>
        ${outcomeHtml}
        <div class="card">
          <strong>${data.decision_created ? "Nova decisÃ£o" : "DecisÃ£o pendente preservada"}</strong>
          <div class="meta">${esc(decision.decision_id || "-")}</div>
          <div class="meta">Categoria: <strong>${esc(rec.category || "-")}</strong> Â· score ${esc(rec.score ?? "-")}</div>
          <p><strong>PrÃ³xima aÃ§Ã£o:</strong> ${esc(rec.action || "-")}</p>
          ${scores}
        </div>
        ${historical ? `<div><strong>HistÃ³rico</strong><ul>${historical}</ul></div>` : ""}
        ${deltaNotes ? `<div><strong>Î”</strong><ul>${deltaNotes}</ul></div>` : ""}
        ${rationale ? `<div><strong>Justificativa</strong><ul>${rationale}</ul></div>` : ""}
      </div>
    `;

    setStatus("âœ“ Ciclo automÃ¡tico concluÃ­do.", true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Executar ciclo automÃ¡tico";
  }
}

async function evaluateLastDecision() {
  try {
    setStatus("Avaliando resultado da Ãºltima decisÃ£o adaptativa...");
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
        <div class="meta">DecisÃ£o avaliada: ${esc(data.decision_id)}</div>
        <div class="meta">Resultado: <strong>${esc(data.outcome_label)}</strong> Â· score ${esc(data.outcome_score)}</div>
        <p><strong>RecomendaÃ§Ã£o avaliada:</strong> ${esc(data.recommendation?.action || "-")}</p>
        ${delta}
        ${notes ? `<ul>${notes}</ul>` : ""}
      </div>
    `;

    setStatus(`âœ“ Resultado avaliado: ${data.outcome_label}.`, true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  }
}

async function runAdaptiveDecision() {
  try {
    setStatus("Executando ciclo adaptativo: memÃ³ria + Î” + estado atual...");
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
        <strong>DecisÃ£o adaptativa</strong>
        <div class="meta">DecisÃ£o: ${esc(data.decision_id || "-")} Â· MemÃ³rias consultadas: ${esc(data.memory_records)}</div>
        <div class="meta">Categoria escolhida: <strong>${esc(rec.category || "-")}</strong></div>
        <div class="meta">Score: ${esc(rec.score ?? "-")}</div>
        <p><strong>PrÃ³xima aÃ§Ã£o:</strong> ${esc(rec.action || "-")}</p>
        <div class="card">${scores}</div>
        ${rationale ? `<ul>${rationale}</ul>` : ""}
      </div>
    `;
    setStatus("âœ“ DecisÃ£o adaptativa concluÃ­da.", true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
  }
}

async function measureDelta() {
  try {
    setStatus("Medindo evoluÃ§Ã£o temporal Î”...");
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
        <strong>EvoluÃ§Ã£o temporal Î”</strong>
        <div class="meta">Linha de base anterior: ${data.baseline_found ? esc(data.baseline_snapshot_id || "sim") : "nÃ£o havia"}</div>
        <div class="meta">Novo snapshot: ${esc(data.saved_snapshot_id || "estado jÃ¡ idÃªntico ao Ãºltimo")}</div>
        ${metrics || '<div class="meta">Sem delta numÃ©rico ainda.</div>'}
        ${notes ? `<ul>${notes}</ul>` : ""}
      </div>
    `;

    setStatus("âœ“ EvoluÃ§Ã£o temporal Î” calculada.", true);
  } catch (err) {
    setStatus(`âœ— ${err.message}`);
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
  setStatus(input.value ? "Backend configurado; teste a conexÃ£o." : "Backend ainda nÃ£o configurado.");
}

init();
```