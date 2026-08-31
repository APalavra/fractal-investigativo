export const DEFAULT_WEIGHTS = {
  aberto:10,
  investigando:7,
  bloqueado:-30,
  dependenciaPendente:-25,
  porDependente:5,
  porDesbloqueio:4,
  semClaims:3,
  porContestado:2
};

export function now(){ return new Date().toISOString(); }

export function freshDB(){
  return {
    versao:"1.0-alpha",
    configPrioridade:{...DEFAULT_WEIGHTS},
    ativa:null,
    historico:[]
  };
}

export function freshInvestigation(alvo=""){
  return {
    id:`INV-${Date.now()}`,
    criadoEm:now(),
    atualizadoEm:now(),
    alvo,
    microNos:[],
    relacoesMicro:[],
    claims:[],
    fontes:[],
    fonteClaims:[],
    relacoes:[],
    counters:{microRoot:1,microRel:1,claim:1,fonte:1,fonteClaim:1,rel:1}
  };
}

function maxNum(arr, prefix){
  let max=0;
  for(const x of arr||[]){
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(x.id||"");
    if(m) max=Math.max(max, Number(m[1]));
  }
  return max+1;
}

export function normalizeInvestigation(i){
  if(!i) return null;

  i.alvo ||= "";
  i.microNos = Array.isArray(i.microNos) ? i.microNos : [];
  i.relacoesMicro = Array.isArray(i.relacoesMicro) ? i.relacoesMicro : [];
  i.claims = Array.isArray(i.claims) ? i.claims : [];
  i.fontes = Array.isArray(i.fontes) ? i.fontes : [];
  i.fonteClaims = Array.isArray(i.fonteClaims) ? i.fonteClaims : [];
  i.relacoes = Array.isArray(i.relacoes) ? i.relacoes : [];

  // compatibilidade com v0.6-v0.8
  for(const n of i.microNos){
    n.parentId = n.parentId ?? null;
    n.descricao ||= "";
    n.estado ||= "aberto";
    n.criadoEm ||= now();
    n.atualizadoEm ||= n.criadoEm;
  }
  for(const c of i.claims){
    c.microalvoId = c.microalvoId ?? null;
    c.tipo ||= "H";
    c.estado ||= "pendente";
    c.confianca = Number.isFinite(Number(c.confianca)) ? Number(c.confianca) : 50;
    c.criadoEm ||= now();
  }
  for(const r of i.relacoes) r.estado ||= "proposta";

  // converte o antigo campo textual fonte de claim em uma fonte estruturada simples
  for(const c of i.claims){
    if(c.fonte && !i.fonteClaims.some(fc=>fc.claimId===c.id)){
      const fonteId = `SRC-${i.fontes.length+1}`;
      i.fontes.push({
        id:fonteId,tipo:"outro",autor:"",titulo:String(c.fonte),
        url:"",trecho:"Migrado automaticamente do campo textual de fonte do claim.",
        confiabilidade:50,criadoEm:now()
      });
      i.fonteClaims.push({
        id:`FS-${i.fonteClaims.length+1}`,
        fonteId,claimId:c.id,tipo:"origem",
        observacao:"Vínculo migrado automaticamente.",criadoEm:now()
      });
    }
    delete c.fonte;
  }

  i.counters ||= {};
  i.counters.microRoot ||= maxNum(i.microNos.filter(n=>/^MA-\d+$/.test(n.id||"")), "MA-");
  i.counters.microRel ||= maxNum(i.relacoesMicro,"MR-");
  i.counters.claim ||= maxNum(i.claims,"CLM-");
  i.counters.fonte ||= maxNum(i.fontes,"SRC-");
  i.counters.fonteClaim ||= maxNum(i.fonteClaims,"FS-");
  i.counters.rel ||= maxNum(i.relacoes,"REL-");

  return i;
}

export function normalizeDB(db){
  if(!db || typeof db!=="object") db=freshDB();
  db.versao="1.0-alpha";
  db.configPrioridade = {...DEFAULT_WEIGHTS, ...(db.configPrioridade||{})};
  for(const k of Object.keys(DEFAULT_WEIGHTS)){
    const n=Number(db.configPrioridade[k]);
    db.configPrioridade[k]=Number.isFinite(n)?n:DEFAULT_WEIGHTS[k];
  }
  db.ativa=normalizeInvestigation(db.ativa);
  db.historico=Array.isArray(db.historico)?db.historico.map(normalizeInvestigation):[];
  return db;
}

export function microDepth(id){ return id ? id.split(".").length : 0; }

export function compareMicro(a,b){
  const pa=(a.id||"").replace("MA-","").split(".").map(Number);
  const pb=(b.id||"").replace("MA-","").split(".").map(Number);
  const n=Math.max(pa.length,pb.length);
  for(let i=0;i<n;i++){
    if(pa[i]===undefined) return -1;
    if(pb[i]===undefined) return 1;
    if(pa[i]!==pb[i]) return pa[i]-pb[i];
  }
  return 0;
}

export function nextChildId(inv,parentId){
  if(!parentId) return `MA-${inv.counters.microRoot++}`;
  const children=inv.microNos.filter(n=>n.parentId===parentId);
  let max=0;
  for(const c of children){
    const tail=(c.id||"").slice(parentId.length+1);
    const n=Number(tail);
    if(Number.isInteger(n)) max=Math.max(max,n);
  }
  return `${parentId}.${max+1}`;
}

export function dependencyPending(inv,microId){
  const deps=inv.relacoesMicro.filter(r=>r.tipo==="depende"&&r.origem===microId);
  return deps.some(r=>{
    const req=inv.microNos.find(m=>m.id===r.destino);
    return req && req.estado!=="resolvido";
  });
}

export function scoreMicro(inv, weights, micro){
  if(micro.estado==="resolvido") return {score:-Infinity,parts:[]};

  const claims=inv.claims.filter(c=>c.microalvoId===micro.id);
  const vars={
    A:micro.estado==="aberto"?1:0,
    I:micro.estado==="investigando"?1:0,
    B:micro.estado==="bloqueado"?1:0,
    D:dependencyPending(inv,micro.id)?1:0,
    G:inv.relacoesMicro.filter(r=>r.tipo==="depende"&&r.destino===micro.id).length,
    U:inv.relacoesMicro.filter(r=>r.tipo==="desbloqueia"&&r.origem===micro.id).length,
    C:claims.length===0?1:0,
    T:claims.filter(c=>c.estado==="contestada").length
  };

  const map={
    A:["aberto","estado aberto"],
    I:["investigando","em investigação"],
    B:["bloqueado","bloqueio manual"],
    D:["dependenciaPendente","dependência pendente"],
    G:["porDependente","microalvos dependentes"],
    U:["porDesbloqueio","desbloqueios declarados"],
    C:["semClaims","ausência de claims"],
    T:["porContestado","claims contestados"]
  };

  const parts=[];
  let score=0;
  for(const [sym,q] of Object.entries(vars)){
    const [key,label]=map[sym];
    const weight=weights[key];
    const subtotal=q*weight;
    score+=subtotal;
    if(q!==0) parts.push(`${sym}: ${q} × ${weight} = ${subtotal} — ${label}`);
  }
  return {score,parts};
}

export function verify(inv){
  const out=[];
  const microIds=new Set(inv.microNos.map(m=>m.id));
  const claimIds=new Set(inv.claims.map(c=>c.id));
  const sourceIds=new Set(inv.fontes.map(s=>s.id));

  for(const m of inv.microNos){
    if(m.parentId && !microIds.has(m.parentId))
      out.push(["error",`${m.id} aponta para pai inexistente ${m.parentId}.`]);
  }

  for(const c of inv.claims){
    if(c.microalvoId && !microIds.has(c.microalvoId))
      out.push(["error",`${c.id} aponta para microalvo inexistente ${c.microalvoId}.`]);
    const hasSource=inv.fonteClaims.some(fc=>fc.claimId===c.id && sourceIds.has(fc.fonteId));
    if(!hasSource)
      out.push(["warn",`${c.id} não possui fonte estruturada vinculada.`]);
  }

  for(const fc of inv.fonteClaims){
    if(!sourceIds.has(fc.fonteId) || !claimIds.has(fc.claimId))
      out.push(["error",`${fc.id} possui referência órfã de fonte ou claim.`]);
  }

  // contradição simples claim->claim
  for(let i=0;i<inv.relacoes.length;i++){
    for(let j=i+1;j<inv.relacoes.length;j++){
      const a=inv.relacoes[i], b=inv.relacoes[j];
      if(a.origem===b.origem && a.destino===b.destino){
        if(new Set([a.tipo,b.tipo]).has("sustenta") && new Set([a.tipo,b.tipo]).has("contradiz"))
          out.push(["error",`Possível inconsistência: ${a.origem} sustenta e contradiz ${a.destino}.`]);
      }
    }
  }

  // ciclos de dependência de qualquer comprimento
  const graph=new Map();
  for(const m of inv.microNos) graph.set(m.id,[]);
  for(const r of inv.relacoesMicro.filter(r=>r.tipo==="depende")){
    if(graph.has(r.origem) && graph.has(r.destino)) graph.get(r.origem).push(r.destino);
  }
  const visiting=new Set(), visited=new Set(), stack=[];
  let cycleFound=false;
  function dfs(node){
    if(cycleFound) return;
    if(visiting.has(node)){
      const idx=stack.indexOf(node);
      const cyc=[...stack.slice(idx),node];
      out.push(["error",`Ciclo de dependência detectado: ${cyc.join(" → ")}.`]);
      cycleFound=true;
      return;
    }
    if(visited.has(node)) return;
    visiting.add(node); stack.push(node);
    for(const next of graph.get(node)||[]) dfs(next);
    stack.pop(); visiting.delete(node); visited.add(node);
  }
  for(const node of graph.keys()) dfs(node);

  for(const m of inv.microNos){
    if(m.estado==="resolvido" && dependencyPending(inv,m.id))
      out.push(["warn",`${m.id} está resolvido, mas ainda possui dependência não resolvida.`]);
  }

  if(!out.length) out.push(["ok","Nenhuma inconsistência estrutural simples foi detectada."]);
  return out;
}
