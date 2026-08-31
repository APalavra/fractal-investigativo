export const KEYS = {
  current: "fractal_investigativo_v1_alpha",
  old: [
    "fractal_investigativo_v08",
    "fractal_investigativo_v07",
    "fractal_investigativo_v06",
    "fractal_investigativo_v05",
    "fractal_investigativo_v04",
    "fractal_investigativo_v03",
    "fractal_investigativo_v02",
    "fractal_memoria"
  ]
};

export function loadRaw(){
  const current = localStorage.getItem(KEYS.current);
  if(current) return {raw: current, from: KEYS.current};

  for(const key of KEYS.old){
    const raw = localStorage.getItem(key);
    if(raw) return {raw, from:key};
  }
  return {raw:null, from:null};
}

export function save(db){
  localStorage.setItem(KEYS.current, JSON.stringify(db));
}

export function resetCurrent(dbFactory){
  const db = dbFactory();
  save(db); // tombstone lógico: impede remigração automática
  return db;
}

export function eraseAll(){
  localStorage.removeItem(KEYS.current);
  for(const key of KEYS.old) localStorage.removeItem(key);
}

export function downloadJSON(db){
  const blob = new Blob([JSON.stringify(db,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fractal-v1-alpha-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
