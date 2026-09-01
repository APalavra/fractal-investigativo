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


class CompareRequest(BaseModel):
    investigation: dict[str, Any]


class CompareResponse(BaseModel):
    memory_version: int
    current_hash: str
    exact_state_matches: int
    prior_categories: dict[str, int]
    repeated_targets: list[str]
    guidance: list[str]


class DeltaRequest(BaseModel):
    investigation: dict[str, Any]
    save_snapshot: bool = True


class DeltaResponse(BaseModel):
    baseline_found: bool
    baseline_snapshot_id: str | None = None
    current_hash: str
    previous_hash: str | None = None
    changes: dict[str, Any]
    interpretation: list[str]
    saved_snapshot_id: str | None = None


class AdaptiveRequest(BaseModel):
    investigation: dict[str, Any]
    save_snapshot: bool = True


class AdaptiveResponse(BaseModel):
    current_hash: str
    snapshot_id: str | None = None
    decision_id: str | None = None
    memory_records: int
    baseline_found: bool
    delta: dict[str, Any]
    adaptive_scores: list[dict[str, Any]]
    recommendation: dict[str, Any]
    rationale: list[str]


class OutcomeRequest(BaseModel):
    investigation: dict[str, Any]


class OutcomeResponse(BaseModel):
    decision_id: str
    recommendation: dict[str, Any]
    outcome_score: int
    outcome_label: str
    changes: dict[str, Any]
    notes: list[str]


class AutoCycleRequest(BaseModel):
    investigation: dict[str, Any]


class AutoCycleResponse(BaseModel):
    memory_version: int
    outcome_evaluated: bool
    outcome: dict[str, Any] | None = None
    comparison: dict[str, Any]
    delta: dict[str, Any]
    decision_created: bool
    decision: dict[str, Any] | None = None
    message: str


class ActionExecutionRequest(BaseModel):
    decision_id: str
    action: dict[str, Any]


class ActionExecutionResponse(BaseModel):
    decision_id: str
    registered: bool


class PendingDecisionResponse(BaseModel):
    found: bool
    decision: dict[str, Any] | None = None



def memory_guidance_for(inv: dict[str, Any]) -> tuple[list[str], set[str]]:
    notes = []
    known = set()
    try:
        mem = load_memory()
    except Exception:
        return notes, known

    inv_hash = stable_hash(inv)
    entries = mem.get("entries", []) or []
    same_state = [e for e in entries if e.get("investigation_hash") == inv_hash]

    if entries:
        notes.append(f"Memória evolutiva contém {len(entries)} registro(s) persistente(s) de ciclos anteriores.")
    if same_state:
        notes.append(f"{len(same_state)} registro(s) pertencem exatamente ao estado atual da investigação.")
        for e in same_state:
            if e.get("proposal_fingerprint"):
                known.add(e["proposal_fingerprint"])
    return notes, known


def proposal_fingerprint_from_model(proposal: Proposal) -> str:
    p = proposal.model_dump()
    return stable_hash({
        "id": p.get("id"),
        "category": p.get("category"),
        "title": p.get("title"),
        "action": p.get("action"),
        "rationale": p.get("rationale"),
        "evidence": p.get("evidence"),
    })


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

    memory_notes, prior_fingerprints = memory_guidance_for(inv)
    comparison = compare_with_memory(inv)
    diagnostics, proposals = list(memory_notes), []
    for note in comparison.guidance:
        if note not in diagnostics:
            diagnostics.append("Histórico: " + note)
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

    if prior_fingerprints:
        filtered = []
        skipped = 0
        for p in proposals:
            if proposal_fingerprint_from_model(p) in prior_fingerprints:
                skipped += 1
            else:
                filtered.append(p)
        proposals = filtered
        if skipped:
            diagnostics.append(
                f"{skipped} proposta(s) idêntica(s) já registradas para este estado foram suprimidas pela memória."
            )

    validations = [validate_proposal(inv, p) for p in proposals]
    for p, v in zip(proposals, validations):
        p.status = "validada" if v.accepted else "rejeitada"

    valid = [p for p, v in zip(proposals, validations) if v.accepted]

    recommended = None
    if valid:
        dominant_category = None
        if comparison.prior_categories:
            dominant_category = max(
                comparison.prior_categories,
                key=comparison.prior_categories.get
            )

        alternatives = [p for p in valid if p.category != dominant_category]
        pool = alternatives or valid

        def score_for_recommendation(p: Proposal) -> tuple[int, int]:
            recurrence_penalty = 0
            evidence_ids = {ref.id for ref in p.evidence}
            if any(rid in evidence_ids for rid in comparison.repeated_targets):
                recurrence_penalty = 8
            return (p.confidence - recurrence_penalty, p.confidence)

        recommended = max(pool, key=score_for_recommendation).id

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
            cur.execute("""
                CREATE TABLE IF NOT EXISTS investigation_snapshots (
                    id BIGSERIAL PRIMARY KEY,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    investigation_hash TEXT NOT NULL,
                    investigation JSONB NOT NULL
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS adaptive_decisions (
                    id BIGSERIAL PRIMARY KEY,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    baseline_hash TEXT NOT NULL,
                    baseline_investigation JSONB NOT NULL,
                    recommendation JSONB NOT NULL,
                    adaptive_scores JSONB NOT NULL,
                    evaluated_at TIMESTAMPTZ,
                    outcome_investigation_hash TEXT,
                    outcome_investigation JSONB,
                    outcome_score INTEGER,
                    outcome_label TEXT,
                    outcome_notes JSONB,
                    executed_action JSONB
                )
            """)
            cur.execute("""
                ALTER TABLE adaptive_decisions
                ADD COLUMN IF NOT EXISTS executed_action JSONB
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



def compare_with_memory(inv: dict[str, Any]) -> CompareResponse:
    mem = load_memory()
    entries = mem.get("entries", []) or []
    current_hash = stable_hash(inv)

    exact = 0
    cats: dict[str, int] = {}
    target_counts: dict[str, int] = {}
    guidance: list[str] = []

    for e in entries:
        if e.get("investigation_hash") == current_hash:
            exact += 1

        p = e.get("proposal") or {}
        cat = p.get("category") or "outro"
        cats[cat] = cats.get(cat, 0) + 1

        for ref in p.get("evidence") or []:
            rid = str(ref.get("id") or "").strip()
            if rid:
                target_counts[rid] = target_counts.get(rid, 0) + 1

    repeated = [
        rid for rid, count in sorted(
            target_counts.items(),
            key=lambda kv: (-kv[1], kv[0])
        )
        if count >= 2
    ]

    if not entries:
        guidance.append("Ainda não há memória evolutiva suficiente para comparação histórica.")
    else:
        guidance.append(
            f"Há {len(entries)} ciclo(s) persistente(s) disponíveis para orientar a investigação."
        )

    if exact:
        guidance.append(
            f"O estado atual já apareceu em {exact} registro(s); evite repetir ações já memorizadas sem mudança factual."
        )

    if repeated:
        guidance.append(
            "Alvos recorrentes na memória: " + ", ".join(repeated[:8]) +
            ". Considere verificar se são gargalos reais ou apenas foco repetitivo."
        )

    if cats:
        top_cat = max(cats, key=cats.get)
        guidance.append(
            f"A categoria mais frequente na memória é '{top_cat}' ({cats[top_cat]} registro(s)). "
            "Busque equilíbrio se outras dimensões estiverem sendo negligenciadas."
        )

    return CompareResponse(
        memory_version=int(mem.get("version", 0)),
        current_hash=current_hash,
        exact_state_matches=exact,
        prior_categories=cats,
        repeated_targets=repeated,
        guidance=guidance,
    )



def investigation_metrics(inv: dict[str, Any]) -> dict[str, Any]:
    claims = inv.get("claims", []) or []
    micros = inv.get("microNos", []) or []
    fontes = inv.get("fontes", []) or []
    rels = inv.get("relacoes", []) or []
    micro_rels = inv.get("relacoesMicro", []) or []
    fonte_claims = inv.get("fonteClaims", []) or []

    contested = sum(1 for c in claims if c.get("estado") == "contestada")
    resolved_micros = sum(1 for m in micros if m.get("estado") == "resolvido")
    active_micros = sum(1 for m in micros if m.get("estado") in ("aberto", "investigando"))
    linked_claim_ids = {str(x.get("claimId")) for x in fonte_claims if x.get("claimId")}
    unsupported_claims = sum(1 for c in claims if str(c.get("id")) not in linked_claim_ids)

    return {
        "claims": len(claims),
        "microalvos": len(micros),
        "fontes": len(fontes),
        "relacoes_claims": len(rels),
        "relacoes_micro": len(micro_rels),
        "vinculos_fonte_claim": len(fonte_claims),
        "claims_contestados": contested,
        "microalvos_resolvidos": resolved_micros,
        "microalvos_ativos": active_micros,
        "claims_sem_fonte": unsupported_claims,
    }


def latest_snapshot() -> dict[str, Any] | None:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, created_at, investigation_hash, investigation
                FROM investigation_snapshots
                ORDER BY id DESC
                LIMIT 1
            """)
            return cur.fetchone()


def save_snapshot(inv: dict[str, Any]) -> str:
    init_db()
    inv_hash = stable_hash(inv)
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO investigation_snapshots (investigation_hash, investigation)
                VALUES (%s, %s::jsonb)
                RETURNING id
            """, (inv_hash, json.dumps(inv, ensure_ascii=False)))
            sid = int(cur.fetchone()["id"])
        conn.commit()
    return f"SNP-{sid}"


def compute_delta(current: dict[str, Any], previous: dict[str, Any] | None) -> tuple[dict[str, Any], list[str]]:
    cur = investigation_metrics(current)
    if previous is None:
        return {
            "current": cur,
            "delta": {},
        }, ["Nenhum snapshot anterior disponível; este estado será usado como linha de base."]

    prev = investigation_metrics(previous)
    delta = {k: cur[k] - prev.get(k, 0) for k in cur}
    notes: list[str] = []

    if delta["claims_sem_fonte"] < 0:
        notes.append(f"Melhora: {-delta['claims_sem_fonte']} claim(s) deixaram de estar sem fonte.")
    elif delta["claims_sem_fonte"] > 0:
        notes.append(f"Atenção: surgiram {delta['claims_sem_fonte']} claim(s) adicionais sem fonte.")

    if delta["claims_contestados"] < 0:
        notes.append(f"Melhora: {-delta['claims_contestados']} contestação(ões) foram resolvidas ou reclassificadas.")
    elif delta["claims_contestados"] > 0:
        notes.append(f"Nova tensão: {delta['claims_contestados']} claim(s) passaram a estado contestado.")

    if delta["microalvos_resolvidos"] > 0:
        notes.append(f"Progresso: {delta['microalvos_resolvidos']} microalvo(s) adicional(is) foram resolvidos.")

    if delta["vinculos_fonte_claim"] > 0:
        notes.append(f"Rastreabilidade aumentou: +{delta['vinculos_fonte_claim']} vínculo(s) fonte→claim.")

    if delta["fontes"] > 0:
        notes.append(f"Base empírica/documental ampliada: +{delta['fontes']} fonte(s).")

    if delta["claims"] == 0 and delta["microalvos"] == 0 and delta["fontes"] == 0 and delta["vinculos_fonte_claim"] == 0:
        notes.append("Estrutura principal praticamente inalterada desde o snapshot anterior.")

    if not notes:
        notes.append("Houve mudança estrutural, mas sem um sinal simples de melhora/piora nas métricas atuais.")

    return {
        "previous": prev,
        "current": cur,
        "delta": delta,
    }, notes



def adaptive_feedback(inv: dict[str, Any], previous_inv: dict[str, Any] | None, memory_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any], list[str], dict[str, Any]]:
    metrics = investigation_metrics(inv)
    changes, delta_notes = compute_delta(inv, previous_inv)
    delta = changes.get("delta", {}) or {}

    # Historical category frequency from persistent evolutionary memory.
    hist: dict[str, int] = {}
    for row in memory_rows:
        proposal = row.get("proposal") or {}
        cat = str(proposal.get("category") or proposal.get("categoria") or "outro")
        hist[cat] = hist.get(cat, 0) + 1

    scores = {
        "evidencia": 0,
        "decomposicao": 0,
        "prioridade": 0,
        "contradicao": 0,
    }
    reasons: dict[str, list[str]] = {k: [] for k in scores}

    # Current-state pressure
    if metrics["claims_sem_fonte"] > 0:
        v = 12 + 4 * metrics["claims_sem_fonte"]
        scores["evidencia"] += v
        reasons["evidencia"].append(f"{metrics['claims_sem_fonte']} claim(s) ainda sem fonte (+{v}).")

    if metrics["microalvos_ativos"] > 0:
        v = min(18, 3 * metrics["microalvos_ativos"])
        scores["decomposicao"] += v
        reasons["decomposicao"].append(f"{metrics['microalvos_ativos']} microalvo(s) ativos (+{v}).")

    if metrics["claims_contestados"] > 0:
        v = 10 + 5 * metrics["claims_contestados"]
        scores["contradicao"] += v
        reasons["contradicao"].append(f"{metrics['claims_contestados']} claim(s) contestado(s) (+{v}).")

    # Delta: reward unresolved deterioration, reduce pressure when improving.
    if delta.get("claims_sem_fonte", 0) > 0:
        scores["evidencia"] += 10
        reasons["evidencia"].append("Δ mostra aumento de claims sem fonte (+10).")
    elif delta.get("claims_sem_fonte", 0) < 0:
        scores["evidencia"] -= 6
        reasons["evidencia"].append("Δ mostra melhora de rastreabilidade (-6).")

    if delta.get("vinculos_fonte_claim", 0) > 0:
        scores["evidencia"] -= 4
        reasons["evidencia"].append("Δ mostra novos vínculos fonte→claim (-4).")

    if delta.get("claims_contestados", 0) > 0:
        scores["contradicao"] += 10
        reasons["contradicao"].append("Δ mostra novas contestações (+10).")
    elif delta.get("claims_contestados", 0) < 0:
        scores["contradicao"] -= 6
        reasons["contradicao"].append("Δ mostra redução de contestações (-6).")

    if delta.get("microalvos_resolvidos", 0) > 0:
        scores["decomposicao"] -= 5
        reasons["decomposicao"].append("Δ mostra microalvos resolvidos (-5).")

    # Historical repetition: repeated categories get a small penalty to avoid tunnel vision.
    for cat, count in hist.items():
        if cat in scores and count:
            penalty = min(8, count * 2)
            scores[cat] -= penalty
            reasons[cat].append(f"Memória registra {count} ciclo(s) dessa categoria; penalidade anti-repetição (-{penalty}).")

    # Priority/gargalo gets pressure from structural dependency density.
    dep_count = sum(1 for r in (inv.get("relacoesMicro", []) or []) if r.get("tipo") == "depende")
    if dep_count:
        v = min(20, 5 * dep_count)
        scores["prioridade"] += v
        reasons["prioridade"].append(f"{dep_count} dependência(s) estrutural(is) ativa(s) (+{v}).")

    ranked = sorted(
        [{"category": k, "score": int(v), "reasons": reasons[k]} for k, v in scores.items()],
        key=lambda x: (-x["score"], x["category"])
    )
    winner = ranked[0]

    actions = {
        "evidencia": "Vincule fonte(s) aos claims sem rastreabilidade antes de elevar a confiança.",
        "decomposicao": "Converta o microalvo ativo mais amplo em uma hipótese/claim diretamente verificável.",
        "prioridade": "Ataque primeiro o microalvo que bloqueia dependências estruturais.",
        "contradicao": "Isole a contestação dominante e registre evidências pró e contra antes de avançar.",
    }
    recommendation = {
        "category": winner["category"],
        "score": winner["score"],
        "action": actions[winner["category"]],
    }

    rationale = [
        f"Categoria adaptativa escolhida: {winner['category']} (score {winner['score']}).",
        *winner["reasons"],
        *delta_notes[:2],
    ]
    return ranked, recommendation, rationale, changes



def load_memory_rows(limit: int = 100) -> list[dict[str, Any]]:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, created_at, investigation_hash, proposal_fingerprint, proposal, validation
                FROM evolutionary_memory
                ORDER BY id DESC
                LIMIT %s
            """, (limit,))
            return list(cur.fetchall())



def save_adaptive_decision(inv: dict[str, Any], recommendation: dict[str, Any], scores: list[dict[str, Any]]) -> str:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO adaptive_decisions (
                    baseline_hash,
                    baseline_investigation,
                    recommendation,
                    adaptive_scores
                )
                VALUES (%s, %s::jsonb, %s::jsonb, %s::jsonb)
                RETURNING id
            """, (
                stable_hash(inv),
                json.dumps(inv, ensure_ascii=False),
                json.dumps(recommendation, ensure_ascii=False),
                json.dumps(scores, ensure_ascii=False),
            ))
            did = int(cur.fetchone()["id"])
        conn.commit()
    return f"DEC-{did}"


def latest_unevaluated_decision() -> dict[str, Any] | None:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, baseline_hash, baseline_investigation,
                       recommendation, adaptive_scores, executed_action
                FROM adaptive_decisions
                WHERE evaluated_at IS NULL
                ORDER BY id DESC
                LIMIT 1
            """)
            return cur.fetchone()


def evaluate_decision_outcome(current_inv: dict[str, Any]) -> dict[str, Any]:
    row = latest_unevaluated_decision()
    if not row:
        raise ValueError("Não há decisão adaptativa pendente para avaliar.")

    baseline = row["baseline_investigation"]
    recommendation = row["recommendation"] or {}
    category = recommendation.get("category")
    changes, notes = compute_delta(current_inv, baseline)
    d = changes.get("delta", {}) or {}

    score = 0
    outcome_notes: list[str] = []

    if category == "evidencia":
        if d.get("claims_sem_fonte", 0) < 0:
            score += 3
            outcome_notes.append("Menos claims ficaram sem fonte (+3).")
        if d.get("vinculos_fonte_claim", 0) > 0:
            score += 3
            outcome_notes.append("Novos vínculos fonte→claim foram criados (+3).")
        if d.get("fontes", 0) > 0:
            score += 1
            outcome_notes.append("A base de fontes aumentou (+1).")
    elif category == "decomposicao":
        if d.get("claims", 0) > 0:
            score += 2
            outcome_notes.append("Novos claims foram criados (+2).")
        if d.get("microalvos_resolvidos", 0) > 0:
            score += 3
            outcome_notes.append("Microalvos foram resolvidos (+3).")
    elif category == "prioridade":
        if d.get("microalvos_resolvidos", 0) > 0:
            score += 4
            outcome_notes.append("Microalvos foram resolvidos após a priorização (+4).")
        if d.get("microalvos_ativos", 0) < 0:
            score += 2
            outcome_notes.append("O número de microalvos ativos caiu (+2).")
    elif category == "contradicao":
        if d.get("claims_contestados", 0) < 0:
            score += 4
            outcome_notes.append("Contestações diminuíram (+4).")

    executed = row.get("executed_action") or {}
    if executed:
        if executed.get("type") == "create_claim":
            claim_id = str(executed.get("claim_id") or "")
            baseline_ids = {str(c.get("id")) for c in (baseline.get("claims", []) or [])}
            current_ids = {str(c.get("id")) for c in (current_inv.get("claims", []) or [])}
            if claim_id and claim_id not in baseline_ids and claim_id in current_ids:
                score += 4
                outcome_notes.append(
                    f"Ação causal confirmada: {claim_id} foi criado após a decisão (+4)."
                )
            else:
                outcome_notes.append(
                    "Ação registrada, mas o claim criado não pôde ser confirmado no estado atual."
                )

    # Generic quality signals
    if d.get("claims_sem_fonte", 0) > 0:
        score -= 2
        outcome_notes.append("Aumentaram claims sem fonte (-2).")
    if d.get("claims_contestados", 0) > 0:
        score -= 2
        outcome_notes.append("Aumentaram claims contestados (-2).")

    if score >= 4:
        label = "melhorou"
    elif score >= 1:
        label = "melhora_parcial"
    elif score == 0:
        label = "neutro"
    else:
        label = "piorou"

    if not outcome_notes:
        outcome_notes.append("Nenhuma métrica diretamente ligada à recomendação mudou.")

    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE adaptive_decisions
                SET evaluated_at = NOW(),
                    outcome_investigation_hash = %s,
                    outcome_investigation = %s::jsonb,
                    outcome_score = %s,
                    outcome_label = %s,
                    outcome_notes = %s::jsonb
                WHERE id = %s
            """, (
                stable_hash(current_inv),
                json.dumps(current_inv, ensure_ascii=False),
                score,
                label,
                json.dumps(outcome_notes, ensure_ascii=False),
                row["id"],
            ))
        conn.commit()

    return {
        "decision_id": f"DEC-{row['id']}",
        "recommendation": recommendation,
        "outcome_score": score,
        "outcome_label": label,
        "changes": d,
        "notes": outcome_notes,
    }


def outcome_history_summary() -> dict[str, Any]:
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT recommendation, outcome_score, outcome_label
                FROM adaptive_decisions
                WHERE evaluated_at IS NOT NULL
                ORDER BY id
            """)
            rows = cur.fetchall()

    by_category: dict[str, list[int]] = {}
    labels: dict[str, int] = {}
    for row in rows:
        cat = str((row["recommendation"] or {}).get("category") or "outro")
        by_category.setdefault(cat, []).append(int(row["outcome_score"] or 0))
        label = str(row["outcome_label"] or "neutro")
        labels[label] = labels.get(label, 0) + 1

    averages = {
        cat: round(sum(vals) / len(vals), 2)
        for cat, vals in by_category.items()
        if vals
    }
    return {
        "evaluated": len(rows),
        "average_score_by_category": averages,
        "labels": labels,
    }



def run_automatic_cycle(inv: dict[str, Any]) -> dict[str, Any]:
    init_db()
    current_hash = stable_hash(inv)

    pending = latest_unevaluated_decision()
    outcome = None
    if pending and pending.get("baseline_hash") != current_hash:
        outcome = evaluate_decision_outcome(inv)

    pending_same_state = latest_unevaluated_decision()
    same_state_pending = bool(
        pending_same_state and pending_same_state.get("baseline_hash") == current_hash
    )

    comparison_model = compare_with_memory(inv)
    comparison = comparison_model.model_dump()

    previous_row = latest_snapshot()
    previous_inv = previous_row["investigation"] if previous_row else None
    changes, interpretation = compute_delta(inv, previous_inv)
    saved_snapshot_id = None
    if not previous_row or previous_row["investigation_hash"] != current_hash:
        saved_snapshot_id = save_snapshot(inv)

    delta = {
        "baseline_found": previous_row is not None,
        "baseline_snapshot_id": f"SNP-{previous_row['id']}" if previous_row else None,
        "saved_snapshot_id": saved_snapshot_id,
        "changes": changes,
        "interpretation": interpretation,
    }

    decision = None
    decision_created = False

    if not same_state_pending:
        memory_rows = load_memory_rows(limit=100)
        ranked, recommendation, rationale, _ = adaptive_feedback(
            inv, previous_inv, memory_rows
        )

        outcome_summary = outcome_history_summary()
        historical_scores = outcome_summary.get("average_score_by_category", {})
        if historical_scores:
            rationale.append(
                "Aprendizado por resultado disponível: " +
                ", ".join(f"{k}={v}" for k, v in historical_scores.items())
            )
            for item in ranked:
                avg = float(historical_scores.get(item["category"], 0))
                item["score"] += round(avg)
            ranked.sort(key=lambda x: (-x["score"], x["category"]))
            winner = ranked[0]
            actions = {
                "evidencia": "Vincule fonte(s) aos claims sem rastreabilidade antes de elevar a confiança.",
                "decomposicao": "Converta o microalvo ativo mais amplo em uma hipótese/claim diretamente verificável.",
                "prioridade": "Ataque primeiro o microalvo que bloqueia dependências estruturais.",
                "contradicao": "Isole a contestação dominante e registre evidências pró e contra antes de avançar.",
            }
            recommendation = {
                "category": winner["category"],
                "score": winner["score"],
                "action": actions[winner["category"]],
            }
            rationale.append(
                f"Score reajustado pelo histórico de resultados; vencedor atual: "
                f"{winner['category']} ({winner['score']})."
            )

        decision_id = save_adaptive_decision(inv, recommendation, ranked)
        decision = {
            "decision_id": decision_id,
            "recommendation": recommendation,
            "adaptive_scores": ranked,
            "rationale": rationale,
        }
        decision_created = True
    else:
        decision = {
            "decision_id": f"DEC-{pending_same_state['id']}",
            "recommendation": pending_same_state.get("recommendation") or {},
            "adaptive_scores": pending_same_state.get("adaptive_scores") or [],
            "rationale": [
                "Já existe uma decisão pendente para este mesmo estado.",
                "Altere a investigação conforme a recomendação antes de gerar outra decisão."
            ],
        }

    mem = load_memory()
    return {
        "memory_version": int(mem.get("version", 0)),
        "outcome_evaluated": outcome is not None,
        "outcome": outcome,
        "comparison": comparison,
        "delta": delta,
        "decision_created": decision_created,
        "decision": decision,
        "message": (
            "Ciclo automático concluído: resultado anterior avaliado e nova decisão criada."
            if outcome is not None and decision_created else
            "Ciclo automático concluído: nova decisão criada."
            if decision_created else
            "Ciclo automático concluído: decisão pendente preservada até a investigação mudar."
        ),
    }



def register_executed_action(decision_id: str, action: dict[str, Any]) -> bool:
    try:
        numeric_id = int(str(decision_id).replace("DEC-", ""))
    except Exception:
        return False
    init_db()
    with db_connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE adaptive_decisions
                SET executed_action = %s::jsonb
                WHERE id = %s
            """, (json.dumps(action, ensure_ascii=False), numeric_id))
            changed = cur.rowcount > 0
        conn.commit()
    return changed


# ---------- HTTP app ----------

app = FastAPI(
    title="Fractal Recuris Bridge",
    version="1.3.0-synchronized-safe-action",
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
    return {"ok": True, "service": "fractal-recuris-bridge", "version": "1.3.0-synchronized-safe-action"}


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


@app.post("/memory/outcome", response_model=OutcomeResponse)
def memory_outcome_route(req: OutcomeRequest):
    if not req.investigation or not isinstance(req.investigation, dict):
        raise HTTPException(status_code=400, detail="investigation ausente ou inválida")
    try:
        result = evaluate_decision_outcome(req.investigation)
        return OutcomeResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@app.get("/memory/pending-decision", response_model=PendingDecisionResponse)
def pending_decision_route():
    row = latest_unevaluated_decision()
    if not row:
        return PendingDecisionResponse(found=False, decision=None)
    decision = {
        "decision_id": f"DEC-{row['id']}",
        "recommendation": row.get("recommendation") or {},
        "adaptive_scores": row.get("adaptive_scores") or [],
        "baseline_hash": row.get("baseline_hash"),
    }
    return PendingDecisionResponse(found=True, decision=decision)


@app.post("/memory/action-execution", response_model=ActionExecutionResponse)
def action_execution_route(req: ActionExecutionRequest):
    ok = register_executed_action(req.decision_id, req.action)
    if not ok:
        raise HTTPException(status_code=404, detail="decisão não encontrada")
    return ActionExecutionResponse(decision_id=req.decision_id, registered=True)


@app.post("/memory/cycle", response_model=AutoCycleResponse)
def memory_auto_cycle_route(req: AutoCycleRequest):
    if not req.investigation or not isinstance(req.investigation, dict):
        raise HTTPException(status_code=400, detail="investigation ausente ou inválida")
    return AutoCycleResponse(**run_automatic_cycle(req.investigation))


@app.post("/memory/adaptive", response_model=AdaptiveResponse)
def memory_adaptive_route(req: AdaptiveRequest):
    if not req.investigation or not isinstance(req.investigation, dict):
        raise HTTPException(status_code=400, detail="investigation ausente ou inválida")

    previous_row = latest_snapshot()
    previous_inv = previous_row["investigation"] if previous_row else None
    memory_rows = load_memory_rows(limit=100)

    ranked, recommendation, rationale, changes = adaptive_feedback(
        req.investigation, previous_inv, memory_rows
    )

    outcome_summary = outcome_history_summary()
    historical_scores = outcome_summary.get("average_score_by_category", {})
    if historical_scores:
        rationale.append(
            "Aprendizado por resultado disponível: " +
            ", ".join(f"{k}={v}" for k, v in historical_scores.items())
        )

        # Small reward/penalty based on proven historical outcomes.
        for item in ranked:
            avg = float(historical_scores.get(item["category"], 0))
            item["score"] += round(avg)

        ranked.sort(key=lambda x: (-x["score"], x["category"]))
        winner = ranked[0]
        recommendation = {
            "category": winner["category"],
            "score": winner["score"],
            "action": {
                "evidencia": "Vincule fonte(s) aos claims sem rastreabilidade antes de elevar a confiança.",
                "decomposicao": "Converta o microalvo ativo mais amplo em uma hipótese/claim diretamente verificável.",
                "prioridade": "Ataque primeiro o microalvo que bloqueia dependências estruturais.",
                "contradicao": "Isole a contestação dominante e registre evidências pró e contra antes de avançar.",
            }[winner["category"]],
        }
        rationale.append(
            f"Score reajustado pelo histórico de resultados; vencedor atual: {winner['category']} ({winner['score']})."
        )

    decision_id = save_adaptive_decision(req.investigation, recommendation, ranked)

    saved_id = None
    current_hash = stable_hash(req.investigation)
    if req.save_snapshot and (not previous_row or previous_row["investigation_hash"] != current_hash):
        saved_id = save_snapshot(req.investigation)

    return AdaptiveResponse(
        current_hash=current_hash,
        snapshot_id=saved_id,
        decision_id=decision_id,
        memory_records=len(memory_rows),
        baseline_found=previous_row is not None,
        delta=changes.get("delta", {}) or {},
        adaptive_scores=ranked,
        recommendation=recommendation,
        rationale=rationale,
    )


@app.post("/memory/delta", response_model=DeltaResponse)
def memory_delta_route(req: DeltaRequest):
    if not req.investigation or not isinstance(req.investigation, dict):
        raise HTTPException(status_code=400, detail="investigation ausente ou inválida")

    previous_row = latest_snapshot()
    previous_inv = previous_row["investigation"] if previous_row else None
    changes, interpretation = compute_delta(req.investigation, previous_inv)

    saved_id = None
    if req.save_snapshot:
        current_hash = stable_hash(req.investigation)
        if not previous_row or previous_row["investigation_hash"] != current_hash:
            saved_id = save_snapshot(req.investigation)

    return DeltaResponse(
        baseline_found=previous_row is not None,
        baseline_snapshot_id=f"SNP-{previous_row['id']}" if previous_row else None,
        current_hash=stable_hash(req.investigation),
        previous_hash=previous_row["investigation_hash"] if previous_row else None,
        changes=changes,
        interpretation=interpretation,
        saved_snapshot_id=saved_id,
    )


@app.post("/memory/compare", response_model=CompareResponse)
def memory_compare_route(req: CompareRequest):
    if not req.investigation or not isinstance(req.investigation, dict):
        raise HTTPException(status_code=400, detail="investigation ausente ou inválida")
    return compare_with_memory(req.investigation)


@app.get("/memory/summary")
def memory_summary_route():
    mem = load_memory()
    entries = mem.get("entries", []) or []
    by_category = {}
    for e in entries:
        p = e.get("proposal") or {}
        cat = p.get("category") or "outro"
        by_category[cat] = by_category.get(cat, 0) + 1

    latest = []
    for e in entries[-10:]:
        p = e.get("proposal") or {}
        latest.append({
            "id": e.get("id"),
            "created_at": e.get("created_at"),
            "proposal_id": p.get("id"),
            "title": p.get("title"),
            "category": p.get("category"),
        })

    return {
        "persistent": True,
        "storage": "postgresql",
        "version": mem.get("version", 0),
        "total_entries": len(entries),
        "by_category": by_category,
        "latest": latest,
    }
