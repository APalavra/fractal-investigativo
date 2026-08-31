import {compareMicro, microDepth} from "./model.js";

export function esc(v){
  if(v===null || v===undefined || v==="") return "—";
  return String(v)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;")
    .replace(/\n/g,"<br>");
}

export function optionFill(select, items, emptyLabel=null){
  select.innerHTML="";
  if(emptyLabel!==null){
    const o=document.createElement("option");
    o.value=""; o.textContent=emptyLabel; select.appendChild(o);
  }
  for(const {value,label} of items){
    const o=document.createElement("option");
    o.value=value; o.textContent=label; select.appendChild(o);
  }
}

export function microOptions(inv){
  return inv.microNos.slice().sort(compareMicro).map(n=>({
    value:n.id,
    label:`${"↳ ".repeat(Math.max(0,microDepth(n.id)-1))}${n.id} — ${n.titulo}`
  }));
}

export function claimOptions(inv){
  return inv.claims.map(c=>({
    value:c.id,
    label:`${c.id} — ${c.texto.length>42?c.texto.slice(0,42)+"...":c.texto}`
  }));
}

export function sourceOptions(inv){
  return inv.fontes.map(s=>({
    value:s.id,
    label:`${s.id} — ${s.titulo||s.autor||s.tipo}`
  }));
}
