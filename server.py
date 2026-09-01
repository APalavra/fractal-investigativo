from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import psycopg
from psycopg.rows import dict_row


# ---------- Schemas ----------

class AnalyzeRequest(BaseModel):
    investigation: dict[str, Any]
    context: dict[str, Any] = Field(default_factory=dict)


class EvidenceRef(BaseModel):
    kind: Literal["microalvo", "claim", "fonte", "relacao", "sistema"]
    id: str
    reason: str


class Proposal(BaseModel):
    id: str
    category: Literal["prioridade", "evidencia", "contradicao", "decomposicao", "qualidade"]
    title: str
    action: str
    rationale: str
    evidence: list[EvidenceRef] = Field(default_factory=list)
    confidence: int = Field(ge=0, le=100)
    status: Literal["proposta", "validada", "rejeitada"] = "proposta"


class ValidationResult(BaseModel):
    proposal_id: str
    accepted: bool
    checks: list[str]
    reasons: list[str]


class AnalyzeResponse(BaseModel):
    engine: str
    input_hash: str
    diagnostics: list[str]
    proposals: list[Proposal]
    validations: list[ValidationResult]
    recommended_proposal_id: str | None = None


class CommitRequest(BaseModel):
    investigation: dict[str, Any]
    proposal: Proposal
    validation: ValidationResult


class CommitResponse(BaseModel):
    committed: bool
    memory_version: int
    entry_id: str | None = None
    message: str
    duplicate: bool = False


# ---------- Core ----------

ENGINE_NAME = "Fractal Evolution Engine 0.1 — ciclo inspirado no Recuris"


def stable_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def known_ids(inv: dict[str, Any]) -> set[str]:
    ids = {"SYSTEM"}
    for key in ("microNos", "claims", "fontes", "relacoes", "relacoesMicro", "fonteClaims"):
        for item in inv.get(key, []) or []:
            if isinstance(item, dict) and item.get("id"):
                ids.add(str(item["id"]))
    return ids


def validate_proposal(inv: dict[str, Any], proposal: Proposal) -> ValidationResult:
    known = known_ids(inv)
    checks, reasons = [], []

    has_action = bool(proposal.action.strip())
    checks.append(f"ação não vazia: {'ok' if has_action else 'falhou'}")
    if not has_action:
        reasons.append("A proposta não descreve uma ação executável.")

    refs_ok = all(ref.id in known for ref in proposal.evidence)
    checks.append(f"referências rastreáveis: {'ok' if refs_ok else 'falhou'}")
    if not refs_ok:
        reasons.append("Há referência de evidência que não existe na investigação recebida.")

    evidence_ok = bool(proposal.evidence)
    checks.append(f"evidência explícita: {'ok' if evidence_ok else 'falhou'}")
    if not evidence_ok:
        reasons.append("A proposta não possui evidência explícita.")

    safe_scope = proposal.category in {"prioridade", "evidencia", "contradicao", "decomposicao", "qualidade"}
    checks.append(f"escopo permitido: {'ok' if safe_scope else 'falhou'}")
    if not safe_scope:
        reasons.append("A proposta está fora do escopo permitido do motor.")

    return ValidationResult(
        proposal_id=proposal.id,
        accepted=has_action and refs_ok and evidence_ok and safe_scope,
        checks=checks,
        reasons=reasons,
    )


def _source_links(inv):
    out = {}
    for link in inv.get("fonteClaims", []) or []:
        cid = link.get("claimId")
        if cid:
            out.setdefault(str(cid), []).append(link)
    return out


def _dependents(inv):
    out = {}
    for rel in inv.get("relacoesMicro", []) or []:
        if rel.get("tipo") == "depende" and rel.get("destino"):
            d = str(rel["destino"])
            out[d] = out.get(d, 0) + 1
    return out


def analyze(inv: dict[str, Any], context: dict[str, Any] | None = None) -> AnalyzeResponse:
    context = context or {}
    claims = inv.get("claims", []) or []
    micros = inv.get("microNos", []) or []
    links = _source_links(inv)
    dependents = _dependents(inv)

    diagnostics, proposals = [], []
    n = 1

    unsupported = [c for c in claims if not links.get(str(c.get("id")))]
    contested = [c for c in claims if c.get("estado") == "contestada"]
    low_conf = [c for c in claims if int(c.get("confianca") or 0) < 50]

    open_without_claims = []
    for m in micros:
        mid = m.get("id")
        if m.get("estado") in ("aberto", "investigando") and not any(c.get("microalvoId") == mid for c in claims):
            open_without_claims.append(m)

    if unsupported:
        diagnostics.append(f"{len(unsupported)} claim(s) sem vínculo explícito com fonte.")
        c = unsupported[0]
        proposals.append(Proposal(
            id=f"EV-{n}", category="evidencia",
            title=f"Dar rastreabilidade a {c.get('id')}",
            action=f"Buscar ou registrar uma fonte e vinculá-la explicitamente ao claim {c.get('id')} antes de elevar sua confiança.",
            rationale="Claims sem fonte são pontos frágeis para uma memória investigativa que precisa justificar sua própria evolução.",
            evidence=[EvidenceRef(kind="claim", id=str(c.get("id")), reason="claim sem fonte vinculada")],
            confidence=92,
        ))
        n += 1

    if contested:
        diagnostics.append(f"{len(contested)} claim(s) contestado(s) exigem resolução ou delimitação.")
        c = sorted(contested, key=lambda x: int(x.get("confianca") or 0))[0]
        proposals.append(Proposal(
            id=f"EV-{n}", category="contradicao",
            title=f"Resolver contestação em {c.get('id')}",
            action=f"Separar as evidências que sustentam e contradizem {c.get('id')}, formular o teste discriminante mínimo e registrar o resultado.",
            rationale="Uma contradição aberta tem alto valor informacional.",
            evidence=[EvidenceRef(kind="claim", id=str(c.get("id")), reason="estado epistemológico contestado")],
            confidence=90,
        ))
        n += 1

    if low_conf:
        diagnostics.append(f"{len(low_conf)} claim(s) abaixo de 50% de confiança.")

    if open_without_claims:
        diagnostics.append(f"{len(open_without_claims)} microalvo(s) ativo(s) ainda sem claims diretos.")
        m = max(open_without_claims, key=lambda x: dependents.get(str(x.get("id")), 0))
        proposals.append(Proposal(
            id=f"EV-{n}", category="decomposicao",
            title=f"Transformar {m.get('id')} em hipótese verificável",
            action=f"Criar pelo menos um claim explícito ligado a {m.get('id')} e definir qual evidência poderia sustentá-lo ou refutá-lo.",
            rationale="Um microalvo sem claim não produz uma unidade epistemológica testável.",
            evidence=[EvidenceRef(kind="microalvo", id=str(m.get("id")), reason="microalvo ativo sem claim direto")],
            confidence=86,
        ))
        n += 1

    if micros:
        most_enabling = max(micros, key=lambda x: dependents.get(str(x.get("id")), 0))
        dep_count = dependents.get(str(most_enabling.get("id")), 0)
        if dep_count > 0:
            diagnostics.append(f"{most_enabling.get('id')} desbloqueia estruturalmente {dep_count} microalvo(s) dependente(s).")
            proposals.append(Proposal(
                id=f"EV-{n}", category="prioridade",
                title=f"Priorizar gargalo {most_enabling.get('id')}",
                action=f"Tratar {most_enabling.get('id')} como candidato prioritário enquanto continuar bloqueando {dep_count} dependência(s).",
                rationale="Resolver um gargalo pode liberar múltiplas ramificações.",
                evidence=[EvidenceRef(kind="microalvo", id=str(most_enabling.get("id")), reason=f"{dep_count} dependente(s) estruturais")],
                confidence=min(95, 74 + dep_count * 4),
            ))
            n += 1

    if not proposals:
        diagnostics.append("Nenhuma fragilidade estrutural óbvia foi detectada pelo motor determinístico atual.")
        if micros:
            m = micros[0]
            proposals.append(Proposal(
                id="EV-1", category="qualidade",
                title="Executar revisão de qualidade",
                action=f"Revisar o microalvo {m.get('id')} procurando premissas ocultas, alternativas e critérios de falsificação.",
                rationale="Quando não há falha estrutural clara, uma revisão direcionada é preferível a inventar uma correção.",
                evidence=[EvidenceRef(kind="microalvo", id=str(m.get("id")), reason="ponto existente para revisão")],
                confidence=68,
            ))
        else:
            proposals.append(Proposal(
                id="EV-1", category="decomposicao",
                title="Criar o primeiro microalvo",
                action="Decompor o alvo principal em um primeiro microalvo verificável.",
                rationale="Sem microalvos não existe unidade operacional para o ciclo investigativo.",
                evidence=[EvidenceRef(kind="sistema", id="SYSTEM", reason="investigação sem microalvos")],
                confidence=95,
            ))

    validations = [validate_proposal(inv, p) for p in proposals]
    for p, v in zip(proposals, validations):
        p.status = "validada" if v.accepted else "rejeitada"

    valid = [p for p, v in zip(proposals, validations) if v.accepted]
    recommended = max(valid, key=lambda p: p.confidence).id if valid else None

    return AnalyzeResponse(
        engine=ENGINE_NAME,
        input_hash=stable_hash({"investigation": inv, "context": context}),
        diagnostics=diagnostics,
        proposals=proposals,
        validations=validations,
        recommended_proposal_id=recommended,
    )


# ---------- Persistent PostgreSQL memory ----------

def database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("DATABASE_URL não configurada.")
    return url


def db_connect():
    return psycopg.connect(database_url(), row_factory=dict_row)


def init_db() -> None:
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS evolutionary_memory (
                    id BIGSERIAL PRIMARY KEY,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    investigation_hash TEXT NOT NULL,
                    proposal_fingerprint TEXT NOT NULL,
                    proposal JSONB NOT NULL,
                    validation JSONB NOT NULL,
                    UNIQUE (investigation_hash, proposal_fingerprint)
                )
            """)
        conn.commit()


def memory_version() -> int:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM evolutionary_memory")
            row = cur.fetchone()
            return int(row["n"])


def load_memory() -> dict[str, Any]:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, created_at, investigation_hash,
                       proposal_fingerprint, proposal, validation
                FROM evolutionary_memory
                ORDER BY id
            """)
            rows = cur.fetchall()

    entries = []
    for row in rows:
        entries.append({
            "id": f"MEM-{row['id']}",
            "created_at": row["created_at"].isoformat(),
            "investigation_hash": row["investigation_hash"],
            "proposal_fingerprint": row["proposal_fingerprint"],
            "proposal": row["proposal"],
            "validation": row["validation"],
        })

    return {
        "schema": "fractal-skill-memory/postgres-0.2",
        "version": len(entries),
        "entries": entries,
    }


def commit_memory(req: CommitRequest) -> CommitResponse:
    if not req.validation.accepted or req.validation.proposal_id != req.proposal.id:
        return CommitResponse(
            committed=False,
            memory_version=memory_version(),
            message="Proposta não possui validação aceita correspondente.",
        )

    init_db()
    inv_hash = stable_hash(req.investigation)
    proposal_payload = req.proposal.model_dump()
    validation_payload = req.validation.model_dump()

    proposal_fingerprint = stable_hash({
        "id": proposal_payload.get("id"),
        "category": proposal_payload.get("category"),
        "title": proposal_payload.get("title"),
        "action": proposal_payload.get("action"),
        "rationale": proposal_payload.get("rationale"),
        "evidence": proposal_payload.get("evidence"),
    })

    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id
                FROM evolutionary_memory
                WHERE investigation_hash = %s
                  AND proposal_fingerprint = %s
                LIMIT 1
            """, (inv_hash, proposal_fingerprint))
            existing = cur.fetchone()

            if existing:
                cur.execute("SELECT COUNT(*) AS n FROM evolutionary_memory")
                version = int(cur.fetchone()["n"])
                return CommitResponse(
                    committed=False,
                    duplicate=True,
                    memory_version=version,
                    entry_id=f"MEM-{existing['id']}",
                    message="Esta mesma proposta já foi registrada para este estado da investigação.",
                )

            try:
                cur.execute("""
                    INSERT INTO evolutionary_memory (
                        investigation_hash,
                        proposal_fingerprint,
                        proposal,
                        validation
                    )
                    VALUES (%s, %s, %s::jsonb, %s::jsonb)
                    RETURNING id
                """, (
                    inv_hash,
                    proposal_fingerprint,
                    json.dumps(proposal_payload, ensure_ascii=False),
                    json.dumps(validation_payload, ensure_ascii=False),
                ))
                new_id = int(cur.fetchone()["id"])
                conn.commit()
            except psycopg.errors.UniqueViolation:
                conn.rollback()
                cur.execute("""
                    SELECT id
                    FROM evolutionary_memory
                    WHERE investigation_hash = %s
                      AND proposal_fingerprint = %s
                    LIMIT 1
                """, (inv_hash, proposal_fingerprint))
                existing = cur.fetchone()
                cur.execute("SELECT COUNT(*) AS n FROM evolutionary_memory")
                version = int(cur.fetchone()["n"])
                return CommitResponse(
                    committed=False,
                    duplicate=True,
                    memory_version=version,
                    entry_id=f"MEM-{existing['id']}" if existing else None,
                    message="Esta mesma proposta já foi registrada para este estado da investigação.",
                )

    return CommitResponse(
        committed=True,
        memory_version=memory_version(),
        entry_id=f"MEM-{new_id}",
        message="Proposta validada registrada permanentemente no PostgreSQL.",
    )


# ---------- HTTP app ----------

app = FastAPI(
    title="Fractal Recuris Bridge",
    version="0.2.0-postgres",
    description="Backend evolutivo do Fractal Investigativo.",
)

origins = [
    x.strip()
    for x in os.getenv(
        "FRONTEND_ORIGINS",
        "https://apalavra.github.io,http://localhost:5500,http://127.0.0.1:5500",
    ).split(",")
    if x.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"ok": True, "service": "fractal-recuris-bridge", "version": "0.2.0-postgres"}


@app.get("/health")
def health():
    try:
        version = memory_version()
        return {
            "ok": True,
            "service": "fractal-recuris-bridge",
            "storage": "postgresql",
            "persistent": True,
            "memory_version": version,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Backend ativo, mas memória PostgreSQL indisponível: {exc}",
        )


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze_route(req: AnalyzeRequest):
    if not req.investigation or not isinstance(req.investigation, dict):
        raise HTTPException(status_code=400, detail="investigation ausente ou inválida")
    return analyze(req.investigation, req.context)


@app.post("/memory/commit", response_model=CommitResponse)
def commit_route(req: CommitRequest):
    return commit_memory(req)


@app.get("/memory")
def memory_route():
    mem = load_memory()
    return {"schema": mem.get("schema"), "version": mem.get("version", 0), "entries": mem.get("entries", [])}
