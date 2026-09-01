import {KEYS, loadRaw, save, resetCurrent, eraseAll, downloadJSON} from "./storage.js";
import {
  DEFAULT_WEIGHTS, freshDB, freshInvestigation, normalizeDB, now,
  nextChildId, compareMicro, microDepth, scoreMicro, verify
} from "./model.js";
import {esc, optionFill, microOptions, claimOptions, sourceOptions} from "./ui.js";

const $=id=>document.getElementById(id);
let db=freshDB();

function persist(){
  if(db.ativa) db.ativa.atualizadoEm=now();
  save(db);
  renderStatus();
}

function load(){
  const {raw,from}=loadRaw();
  if(raw){
    try{
      db=normalizeDB(JSON.parse(raw));
      save(db);
      if(from!==KEYS.current) setTimeout(()=>alert(`Memória anterior encontrada em ${from} e migrada para v1.0-alpha.`),50);
    }catch(e){
      alert("Falha ao carregar memória. Um banco vazio foi iniciado.");
      db=freshDB(); save(db);
    }
  }else{
    db=freshDB(); save(db);
  }
}

function ensureInv(){
  if(!db.ativa){ alert("Inicie uma investigação primeiro."); return false; }
  return true;
}

function initOrContinue(){
  const alvo=$("alvo").value.trim();
  if(!alvo){ alert("Digite o alvo principal."); return; }
  if(!db.ativa) db.ativa=freshInvestigation(alvo);
  else db.ativa.alvo=alvo;
  persist();
  renderAll();
}

function archiveCurrent(){
  if(!db.ativa) return;
  const copy=JSON.parse(JSON.stringify(db.ativa));
  copy.arquivadoEm=now();
  db.historico.push(copy);
  db.ativa=null;
  persist();
  renderAll();
}

function newInvestigation(){
  if(db.ativa && !confirm("Arquivar a investigação atual e iniciar outra?")) return;
  if(db.ativa) archiveCurrent();
  $("alvo").value="";
  renderAll();
  window.scrollTo({top:0,behavior:"smooth"});
}

function addMicro(){
  if(!ensureInv()) return;
  const titulo=$("microTitulo").value.trim();
  if(!titulo){ alert("Digite o título do microalvo."); return; }
  const parentId=$("microPai").value||null;
  const id=nextChildId(db.ativa,parentId);
  db.ativa.microNos.push({
    id,parentId,titulo,descricao:$("microDescricao").value.trim(),
    estado:"aberto",criadoEm:now(),atualizadoEm:now()
  });
  $("microTitulo").value=""; $("microDescricao").value="";
  persist(); renderAll();
}

window.updateMicro=(id)=>{
  const m=db.ativa.microNos.find(x=>x.id===id); if(!m)return;
  const t=$(`mt-${id}`).value.trim();
  const d=$(`md-${id}`).value.trim();
  m.titulo=t||m.titulo; m.descricao=d; m.estado=$(`ms-${id}`).value; m.atualizadoEm=now();
  persist(); renderAll();
};

window.removeMicro=(id)=>{
  const affected=db.ativa.microNos.filter(n=>n.id===id||n.id.startsWith(id+"."));
  if(!confirm(`Remover ${affected.length} microalvo(s) deste ramo? Claims associados serão preservados, mas desvinculados.`)) return;
  const ids=new Set(affected.map(x=>x.id));
  db.ativa.microNos=db.ativa.microNos.filter(x=>!ids.has(x.id));
  db.ativa.relacoesMicro=db.ativa.relacoesMicro.filter(r=>!ids.has(r.origem)&&!ids.has(r.destino));
  for(const c of db.ativa.claims) if(ids.has(c.microalvoId)) c.microalvoId=null;
  persist(); renderAll();
};

function addMR(){
  if(!ensureInv()||db.ativa.microNos.length<2){alert("Crie pelo menos dois microalvos.");return;}
  const origem=$("mrOrigem").value, destino=$("mrDestino").value, tipo=$("mrTipo").value;
  if(!origem||!destino||origem===destino){alert("Escolha dois microalvos diferentes.");return;}
  if(db.ativa.relacoesMicro.some(r=>r.origem===origem&&r.destino===destino&&r.tipo===tipo)){alert("Relação duplicada.");return;}
  db.ativa.relacoesMicro.push({
    id:`MR-${db.ativa.counters.microRel++}`,origem,destino,tipo,
    observacao:$("mrObs").value.trim(),criadoEm:now()
  });
  $("mrObs").value=""; persist(); renderAll();
}

window.removeMR=id=>{
  if(!confirm(`Remover ${id}?`))return;
  db.ativa.relacoesMicro=db.ativa.relacoesMicro.filter(r=>r.id!==id);
  persist();renderAll();
};

function addClaim(){
  if(!ensureInv())return;
  const texto=$("claimTexto").value.trim();
  if(!texto){alert("Digite a afirmação.");return;}
  db.ativa.claims.push({
    id:`CLM-${db.ativa.counters.claim++}`,
    texto,tipo:$("claimTipo").value,estado:$("claimEstado").value,
    microalvoId:$("claimMicro").value||null,
    confianca:Number($("claimConf").value),criadoEm:now(),atualizadoEm:now()
  });
  $("claimTexto").value="";$("claimConf").value=50;$("claimConfVal").textContent="50";
  persist();renderAll();
}

window.updateClaim=id=>{
  const c=db.ativa.claims.find(x=>x.id===id);if(!c)return;
  c.texto=$(`ct-${id}`).value.trim()||c.texto;
  c.tipo=$(`cy-${id}`).value;
  c.estado=$(`ce-${id}`).value;
  c.microalvoId=$(`cm-${id}`).value||null;
  c.confianca=Number($(`cc-${id}`).value);
  c.atualizadoEm=now();
  persist();renderAll();
};

window.removeClaim=id=>{
  if(!confirm(`Remover ${id} e todas as relações ligadas a ele?`))return;
  db.ativa.claims=db.ativa.claims.filter(c=>c.id!==id);
  db.ativa.relacoes=db.ativa.relacoes.filter(r=>r.origem!==id&&r.destino!==id);
  db.ativa.fonteClaims=db.ativa.fonteClaims.filter(fc=>fc.claimId!==id);
  persist();renderAll();
};

function addSource(){
  if(!ensureInv())return;
  const titulo=$("srcTitulo").value.trim();
  const autor=$("srcAutor").value.trim();
  if(!titulo && !autor){alert("Informe ao menos título ou autor/instituição.");return;}
  db.ativa.fontes.push({
    id:`SRC-${db.ativa.counters.fonte++}`,
    tipo:$("srcTipo").value,autor,titulo,url:$("srcUrl").value.trim(),
    trecho:$("srcTrecho").value.trim(),confiabilidade:Number($("srcConf").value),
    criadoEm:now(),atualizadoEm:now()
  });
  ["srcAutor","srcTitulo","srcUrl","srcTrecho"].forEach(id=>$(id).value="");
  $("srcConf").value=70;$("srcConfVal").textContent="70";
  persist();renderAll();
}

window.updateSource=id=>{
  const s=db.ativa.fontes.find(x=>x.id===id);if(!s)return;
  s.tipo=$(`st-${id}`).value;s.autor=$(`sa-${id}`).value.trim();
  s.titulo=$(`ss-${id}`).value.trim();s.url=$(`su-${id}`).value.trim();
  s.trecho=$(`sx-${id}`).value.trim();s.confiabilidade=Number($(`sc-${id}`).value);
  s.atualizadoEm=now();persist();renderAll();
};

window.removeSource=id=>{
  if(!confirm(`Remover ${id}? Vínculos fonte→claim também serão removidos.`))return;
  db.ativa.fontes=db.ativa.fontes.filter(s=>s.id!==id);
  db.ativa.fonteClaims=db.ativa.fonteClaims.filter(fc=>fc.fonteId!==id);
  persist();renderAll();
};

function addFS(){
  if(!ensureInv())return;
  const fonteId=$("fsFonte").value, claimId=$("fsClaim").value, tipo=$("fsTipo").value;
  const natureza=$("fsNatureza")?.value || "nao_classificada";
  if(!fonteId||!claimId){alert("Crie ao menos uma fonte e um claim.");return;}
  if(db.ativa.fonteClaims.some(x=>x.fonteId===fonteId&&x.claimId===claimId&&x.tipo===tipo)){alert("Vínculo duplicado.");return;}
  db.ativa.fonteClaims.push({
    id:`FS-${db.ativa.counters.fonteClaim++}`,fonteId,claimId,tipo,natureza,
    observacao:$("fsObs").value.trim(),criadoEm:now()
  });
  $("fsObs").value="";persist();renderAll();
}

window.removeFS=id=>{
  db.ativa.fonteClaims=db.ativa.fonteClaims.filter(x=>x.id!==id);
  persist();renderAll();
};

function addRel(){
  if(!ensureInv()||db.ativa.claims.length<2){alert("Crie pelo menos dois claims.");return;}
  const origem=$("relOrigem").value,destino=$("relDestino").value,tipo=$("relTipo").value;
  if(!origem||!destino||origem===destino){alert("Escolha dois claims diferentes.");return;}
  if(db.ativa.relacoes.some(r=>r.origem===origem&&r.destino===destino&&r.tipo===tipo)){alert("Relação duplicada.");return;}
  db.ativa.relacoes.push({
    id:`REL-${db.ativa.counters.rel++}`,origem,destino,tipo,
    estado:$("relEstado").value,observacao:$("relObs").value.trim(),criadoEm:now()
  });
  $("relObs").value="";persist();renderAll();
}

window.updateRelState=(id,val)=>{
  const r=db.ativa.relacoes.find(x=>x.id===id);if(!r)return;r.estado=val;persist();
};

window.removeRel=id=>{
  db.ativa.relacoes=db.ativa.relacoes.filter(r=>r.id!==id);persist();renderAll();
};

function readWeights(){
  return {
    aberto:Number($("wAberto").value),
    investigando:Number($("wInvestigando").value),
    bloqueado:Number($("wBloqueado").value),
    dependenciaPendente:Number($("wDependencia").value),
    porDependente:Number($("wDependente").value),
    porDesbloqueio:Number($("wDesbloqueio").value),
    semClaims:Number($("wSemClaims").value),
    porContestado:Number($("wContestado").value)
  };
}
function saveWeights(){
  const w=readWeights();
  if(Object.values(w).some(x=>!Number.isFinite(x))){alert("Há peso inválido.");return;}
  db.configPrioridade=w;persist();renderFormula();renderRanking();
}
function resetWeights(){db.configPrioridade={...DEFAULT_WEIGHTS};persist();renderAll();}

function renderFormula(){
  const w=db.configPrioridade;
  $("formula").innerHTML=`P(m) = ${w.aberto}·A + (${w.investigando})·I + (${w.bloqueado})·B + (${w.dependenciaPendente})·D + (${w.porDependente})·G + (${w.porDesbloqueio})·U + (${w.semClaims})·C + (${w.porContestado})·T`;
  const map={
    wAberto:"aberto",wInvestigando:"investigando",wBloqueado:"bloqueado",
    wDependencia:"dependenciaPendente",wDependente:"porDependente",
    wDesbloqueio:"porDesbloqueio",wSemClaims:"semClaims",wContestado:"porContestado"
  };
  for(const [id,key] of Object.entries(map)) $(id).value=w[key];
}

function renderRanking(){
  if(!db.ativa)return;
  const arr=db.ativa.microNos.map(m=>({m,...scoreMicro(db.ativa,db.configPrioridade,m)}))
    .filter(x=>Number.isFinite(x.score))
    .sort((a,b)=>b.score-a.score||compareMicro(a.m,b.m));
  $("ranking").innerHTML=arr.length?`<h3>Ranking</h3>`:"<p>Nenhum microalvo ativo.</p>";
  arr.forEach((x,i)=>{
    $("ranking").insertAdjacentHTML("beforeend",`
      <div class="item ${i===0?"top":""}">
        <strong>#${i+1} — ${esc(x.m.id)} — ${esc(x.m.titulo)}</strong>
        <div class="meta">${x.score} pontos</div>
        <p class="meta">${x.parts.map(esc).join("<br>")||"Nenhum componente ativo."}</p>
      </div>`);
  });
}

function renderVerification(){
  if(!db.ativa)return;
  const out=verify(db.ativa);
  $("verificacoes").innerHTML="";
  for(const [cls,msg] of out){
    $("verificacoes").insertAdjacentHTML("beforeend",`<div class="item ${cls}">${esc(msg)}</div>`);
  }
  const inv=db.ativa;
  $("metricas").innerHTML=`
    <div class="metricgrid">
      <div class="metric"><strong>${inv.microNos.length}</strong><br>Microalvos</div>
      <div class="metric"><strong>${Math.max(0,...inv.microNos.map(m=>microDepth(m.id)))}</strong><br>Profundidade máxima</div>
      <div class="metric"><strong>${inv.claims.length}</strong><br>Claims</div>
      <div class="metric"><strong>${inv.fontes.length}</strong><br>Fontes</div>
      <div class="metric"><strong>${inv.relacoes.length}</strong><br>Relações entre claims</div>
      <div class="metric"><strong>${inv.relacoesMicro.length}</strong><br>Relações entre microalvos</div>
    </div>`;
}

function renderMicroList(){
  if(!db.ativa)return;
  const opts=microOptions(db.ativa);
  optionFill($("microPai"),opts,"ALVO PRINCIPAL");
  optionFill($("claimMicro"),opts,"Sem microalvo específico");
  optionFill($("mrOrigem"),opts);
  optionFill($("mrDestino"),opts);
  $("microLista").innerHTML="";
  db.ativa.microNos.slice().sort(compareMicro).forEach(m=>{
    const margin=Math.min((microDepth(m.id)-1)*16,80);
    $("microLista").insertAdjacentHTML("beforeend",`
      <div class="item tree" style="margin-left:${margin}px">
        <strong>${esc(m.id)}</strong>
        <label>Título</label><input id="mt-${m.id}" value="${esc(m.titulo)}">
        <label>Descrição</label><textarea id="md-${m.id}">${esc(m.descricao)}</textarea>
        <label>Estado</label>
        <select id="ms-${m.id}">
          ${["aberto","investigando","resolvido","bloqueado"].map(s=>`<option value="${s}" ${m.estado===s?"selected":""}>${s}</option>`).join("")}
        </select>
        <div class="row">
          <button class="secondary" onclick="updateMicro('${m.id}')">Salvar edição</button>
          <button class="danger" onclick="removeMicro('${m.id}')">Remover ramo</button>
        </div>
      </div>`);
  });
}

function renderMR(){
  if(!db.ativa)return;
  $("mrLista").innerHTML="";
  for(const r of db.ativa.relacoesMicro){
    $("mrLista").insertAdjacentHTML("beforeend",`
      <div class="item"><strong>${esc(r.id)}</strong><p>${esc(r.origem)} → <b>${esc(r.tipo)}</b> → ${esc(r.destino)}</p>
      <div class="meta">${esc(r.observacao)}</div><button class="danger" onclick="removeMR('${r.id}')">Remover</button></div>`);
  }
}

function renderClaims(){
  if(!db.ativa)return;
  const mopts=microOptions(db.ativa);
  $("claimLista").innerHTML="";
  for(const c of db.ativa.claims){
    $("claimLista").insertAdjacentHTML("beforeend",`
      <div class="item">
        <strong>${esc(c.id)}</strong>
        <label>Texto</label><textarea id="ct-${c.id}">${esc(c.texto)}</textarea>
        <div class="grid2">
          <label>Tipo<select id="cy-${c.id}">${["B","L","M","C","H"].map(v=>`<option ${c.tipo===v?"selected":""}>${v}</option>`).join("")}</select></label>
          <label>Estado<select id="ce-${c.id}">${["pendente","apoiada","contestada","rejeitada"].map(v=>`<option value="${v}" ${c.estado===v?"selected":""}>${v}</option>`).join("")}</select></label>
        </div>
        <label>Microalvo<select id="cm-${c.id}"><option value="">Sem microalvo</option>${mopts.map(o=>`<option value="${o.value}" ${c.microalvoId===o.value?"selected":""}>${esc(o.label)}</option>`).join("")}</select></label>
        <label>Confiança <input id="cc-${c.id}" type="number" min="0" max="100" value="${c.confianca}"></label>
        <div class="row">
          <button class="secondary" onclick="updateClaim('${c.id}')">Salvar edição</button>
          <button class="danger" onclick="removeClaim('${c.id}')">Remover</button>
        </div>
      </div>`);
  }
}

function renderSources(){
  if(!db.ativa)return;
  $("fonteLista").innerHTML="";
  for(const s of db.ativa.fontes){
    $("fonteLista").insertAdjacentHTML("beforeend",`
      <div class="item"><strong>${esc(s.id)}</strong>
      <div class="grid2">
        <label>Tipo<select id="st-${s.id}">${["artigo","livro","site","experimento","documento","raciocinio","outro"].map(v=>`<option value="${v}" ${s.tipo===v?"selected":""}>${v}</option>`).join("")}</select></label>
        <label>Autor<input id="sa-${s.id}" value="${esc(s.autor)}"></label>
      </div>
      <label>Título<input id="ss-${s.id}" value="${esc(s.titulo)}"></label>
      <label>URL<input id="su-${s.id}" value="${esc(s.url)}"></label>
      <label>Trecho<textarea id="sx-${s.id}">${esc(s.trecho)}</textarea></label>
      <label>Confiabilidade<input id="sc-${s.id}" type="number" min="0" max="100" value="${s.confiabilidade}"></label>
      <div class="row"><button class="secondary" onclick="updateSource('${s.id}')">Salvar edição</button><button class="danger" onclick="removeSource('${s.id}')">Remover</button></div>
      </div>`);
  }
}

function updateFSNatureza(id,natureza){
  if(!db.ativa)return;
  const item=db.ativa.fonteClaims.find(x=>x.id===id);
  if(!item)return;
  item.natureza=natureza||"nao_classificada";
  persist();
  renderFS();
}
window.updateFSNatureza=updateFSNatureza;

function renderFS(){
  if(!db.ativa)return;
  optionFill($("fsFonte"),sourceOptions(db.ativa));
  optionFill($("fsClaim"),claimOptions(db.ativa));
  $("fsLista").innerHTML="";
  const naturezas=[
    ["nao_classificada","Não classificada"],
    ["teorica","Teórica"],
    ["experimental","Experimental"],
    ["observacional","Observacional"],
    ["documental","Documental"],
    ["argumentativa","Argumentativa"]
  ];
  for(const x of db.ativa.fonteClaims){
    const atual=x.natureza||"nao_classificada";
    $("fsLista").insertAdjacentHTML("beforeend",`
      <div class="item"><strong>${esc(x.id)}</strong><p>${esc(x.fonteId)} → <b>${esc(x.tipo)}</b> → ${esc(x.claimId)}</p>
      <label>Natureza da evidência<select class="inline-select" onchange="updateFSNatureza('${x.id}',this.value)">
        ${naturezas.map(([v,l])=>`<option value="${v}" ${atual===v?"selected":""}>${l}</option>`).join("")}
      </select></label>
      <div class="meta">${esc(x.observacao)}</div><button class="danger" onclick="removeFS('${x.id}')">Remover</button></div>`);
  }
}

function renderRelations(){
  if(!db.ativa)return;
  const opts=claimOptions(db.ativa);
  optionFill($("relOrigem"),opts);optionFill($("relDestino"),opts);
  $("relLista").innerHTML="";
  for(const r of db.ativa.relacoes){
    $("relLista").insertAdjacentHTML("beforeend",`
      <div class="item"><strong>${esc(r.id)}</strong><p>${esc(r.origem)} → <b>${esc(r.tipo)}</b> → ${esc(r.destino)}</p>
      <label>Estado<select class="inline-select" onchange="updateRelState('${r.id}',this.value)">
        ${["proposta","validada","contestada"].map(v=>`<option value="${v}" ${r.estado===v?"selected":""}>${v}</option>`).join("")}
      </select></label>
      <div class="meta">${esc(r.observacao)}</div><button class="danger" onclick="removeRel('${r.id}')">Remover</button></div>`);
  }
}

function renderStatus(){
  const active=!!db.ativa;
  $("app").classList.toggle("hidden",!active);
  $("statusPrincipal").textContent=active?`✓ ${db.ativa.id} ativa e salva.`:"Nenhuma investigação ativa.";
  $("statusMemoria").textContent=active?`✓ Memória v1.0-alpha persistida localmente. Microalvos: ${db.ativa.microNos.length}; claims: ${db.ativa.claims.length}; fontes: ${db.ativa.fontes.length}.`:"Nenhuma investigação ativa.";
  if(active) $("alvo").value=db.ativa.alvo||"";
  $("historico").innerHTML=(db.historico||[]).slice().reverse().map(i=>`<div class="item"><strong>${esc(i.id)}</strong><p>${esc(i.alvo)}</p><div class="meta">${i.microNos.length} microalvos · ${i.claims.length} claims · ${(i.fontes||[]).length} fontes</div></div>`).join("")||"<p class='muted'>Nenhuma investigação arquivada.</p>";
}

function renderAll(){
  renderStatus();
  if(!db.ativa)return;
  renderMicroList();renderMR();renderClaims();renderSources();renderFS();renderRelations();renderFormula();
}

function exportDB(){downloadJSON(db);}

function importDBFile(file){
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const incoming=normalizeDB(JSON.parse(e.target.result));
      if(!confirm("Substituir a memória atual pelo backup selecionado?"))return;
      db=incoming;persist();renderAll();alert("Backup importado.");
    }catch(err){alert("Backup inválido.");}
  };
  reader.readAsText(file);
}

function resetAlpha(){
  if(!confirm("Reiniciar a v1.0-alpha? As versões antigas continuarão preservadas, mas NÃO serão remigradas automaticamente."))return;
  db=resetCurrent(freshDB);renderAll();$("alvo").value="";
}

function eraseEverything(){
  if(!confirm("ATENÇÃO: isso apagará todas as memórias locais conhecidas do Fractal neste navegador, inclusive versões antigas. Continuar?"))return;
  if(!confirm("Confirma a exclusão total das versões locais?"))return;
  eraseAll();db=freshDB();save(db);renderAll();$("alvo").value="";
}

$("btnIniciar").onclick=initOrContinue;
$("btnNova").onclick=newInvestigation;
$("btnArquivar").onclick=archiveCurrent;
$("btnAddMicro").onclick=addMicro;
$("btnAddMR").onclick=addMR;
$("btnAddClaim").onclick=addClaim;
$("btnAddFonte").onclick=addSource;
$("btnAddFS").onclick=addFS;
$("btnAddRel").onclick=addRel;
$("btnSalvarPesos").onclick=saveWeights;
$("btnResetPesos").onclick=resetWeights;
$("btnPrioridade").onclick=renderRanking;
$("btnVerificar").onclick=renderVerification;
$("btnExportar").onclick=exportDB;
$("btnImportar").onclick=()=>$("inputImportar").click();
$("inputImportar").onchange=e=>{const f=e.target.files[0];if(f)importDBFile(f);e.target.value="";};
$("btnResetAtual").onclick=resetAlpha;
$("btnApagarTudo").onclick=eraseEverything;
$("claimConf").oninput=e=>$("claimConfVal").textContent=e.target.value;
$("srcConf").oninput=e=>$("srcConfVal").textContent=e.target.value;


window.addEventListener("fractal:external-db-update", (event) => {
  try {
    if(!event.detail?.db) return;
    db = normalizeDB(event.detail.db);
    save(db);
    renderAll();
    window.dispatchEvent(new CustomEvent("fractal:external-db-applied"));
  } catch (err) {
    console.error("Falha ao aplicar atualização externa do banco Fractal:", err);
  }
});

window.addEventListener("beforeunload",()=>{if(db.ativa)persist();});

load();
renderAll();
