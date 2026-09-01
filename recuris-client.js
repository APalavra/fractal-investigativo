const DB_KEY = "fractal_investigativo_v1_alpha";
const BACKEND_KEY = "fractal_backend_url";
const DEFAULT_BACKEND_URL = "https://fractal-investigativo.onrender.com";
let lastAnalysis = null;

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

function init() {
  const input = $("evoBackendUrl");
  if (!input) return;
  input.value = localStorage.getItem(BACKEND_KEY) || DEFAULT_BACKEND_URL;
  $("btnEvoTestar").addEventListener("click", testBackend);
  $("btnEvoAnalisar").addEventListener("click", analyzeCurrent);
  $("btnEvoMemoria").addEventListener("click", showMemorySummary);
  $("btnEvoComparar").addEventListener("click", compareWithMemory);
  setStatus(input.value ? "Backend configurado; teste a conexão." : "Backend ainda não configurado.");
}

init();
