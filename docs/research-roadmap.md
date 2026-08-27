# Trellis Research Roadmap

Trellis's post-audit architecture is event-sourced, SQLite-backed, with lexical-only retrieval and no vector embeddings. This roadmap compares Trellis against 10 reference systems to identify the highest-leverage next evolutions — bi-temporal facts, durable execution, research planning, graph memory, storage abstraction, throughput, memory staging, ontology reasoning, and long-term-memory UX.

## Priority-Ranked Findings

| # | Project | What to Steal | Trellis Integration Point | Effort | Adoption |
|---|---------|--------------|--------------------------|--------|----------|
| 1 | Graphiti | Bi-temporal `valid_at`/`expired_at` + contradiction-driven invalidation | `src/store/readModel/`, `src/graph/claimReconciler.ts`, `src/query/longitudinal.ts` | small–medium | next-phase |
| 2 | PaperQA2 | LLM reranking + contextual summarization (RCS) before claim extraction | `src/research/passageSelection.ts` | medium | next-phase |
| 3 | LangGraph | Step-level checkpointing with pending-writes retention + `interrupt()` | `src/research/scheduler.ts`, `src/research/strategies/agentStrategy.ts` | medium | next-phase |
| 4 | STORM/Co-STORM | Perspective-seeded question decomposition + simulated follow-up + moderator gap-finder | `src/research/strategies/agentStrategy.ts` | small–medium | next-phase |
| 5 | HippoRAG 2 | PPR over `rm_claim_relations` + index-manifest versioning | new `src/graph/pprRetrieval.ts`, `src/store/projectionBuilder.ts` | medium | next-phase |
| 6 | LightRAG | Storage-facet abstraction (KV/Vector/Graph/DocStatus) with pluggable backends | new `src/store/vectorStore.ts`, `src/store/docStatusStore.ts` | medium | next-phase |
| 7 | GPT Researcher | Parallel sub-query fan-out + semaphore-gated concurrency | `src/research/strategies/agentStrategy.ts`, `src/research/scheduler.ts` | small | next-phase |
| 8 | Cognee | Session-memory fast path + ontology-guided extraction + staged lifecycle | `src/store/events.ts`, `src/research/claimExtraction.ts` | small–medium | next-phase |
| 9 | KAG/OpenSPG | Lightweight claim-type ontology + logical-form decomposition | `src/store/schema.ts`, `src/research/strategies/agentStrategy.ts` | small–large | next-phase / long-term |
| 10 | Letta | Agent-authored memory files + background consolidation + provenance explain | new `src/memory/`, `src/research/consolidation.ts`, `src/query/longitudinal.ts` | small–medium | next-phase |

---

## Per-Project Detail

### 1. Graphiti (Zep) — Bi-Temporal Model, Incremental Construction, Point-in-Time Retrieval

**Verified Facts:**
- Tracks 4 temporal fields: `created_at`/`valid_at`/`invalid_at`/`expired_at` on edges, separating world-time from system-time. ([DeepWiki](https://deepwiki.com/getzep/graphiti/3.2-temporal-awareness))
- Incremental per-episode processing: entities/edges extracted and deduplicated against existing graph — no batch recomputation. ([GitHub](https://github.com/getzep/graphiti))
- Backends: Neo4j 5.26+, FalkorDB 1.1.2+, Amazon Neptune; pluggable DB abstraction layer. ([Zep Docs](https://help.getzep.com/graphiti/getting-started/quick-start))
- Point-in-time queries via `SearchFilters` on all 4 temporal axes + `retrieve_episodes` with `reference_time`. ([DeepWiki](https://deepwiki.com/getzep/graphiti/3.2-temporal-awareness))
- Contradiction-driven invalidation: superseded edges get `expired_at` set. Known bugs — unrelated facts retiring each other (Issue #1728). ([GitHub #1728](https://github.com/getzep/graphiti/issues/1728))

**Gap vs Trellis:**
- No bi-temporal schema — `src/store/events.ts` has `observedAt` but no `valid_at`/`expired_at`. `src/graph/claimReconciler.ts` classifies supersession but doesn't persist temporal windows.
- No incremental graph construction — `src/store/projectionBuilder.ts` rebuilds read models from event log; no per-episode dedup.
- No graph DB backend — single SQLite; no Cypher traversal.

**Recommendation:**
- Add `valid_at`/`expired_at` columns to `rm_claims`/`rm_claim_relations` in `src/store/readModel/`. **Effort: small.**
- Point-in-time query in `src/query/longitudinal.ts`: add `WHERE` clause filtering on validity windows. **Effort: small.**
- Contradiction-driven invalidation in `src/graph/claimReconciler.ts`: write `EXPIRED` event on `supersedes`. **Effort: medium.**
- Graph backend: defer. **Effort: large.**

---

### 2. PaperQA2 (Future-House) — LLM Reranking, Citation Traversal, Multi-Provider Metadata

**Verified Facts:**
- Agentic RAG with iterative tool calls (PaperSearch → GatherEvidence → GenerateAnswer, Reset, Complete). ([README](https://github.com/Future-House/paper-qa/blob/main/README.md), [Blog](https://www.futurehouse.org/research/engineering-blog-journey-to-superhuman-performance-on-scientific-tasks))
- LLM Re-ranking + Contextual Summarization (RCS): embedding-rank → LLM scores top-k chunks 1–10, produces ≤300-word summaries. Saturation at top-k 20–30. ([Blog](https://www.futurehouse.org/research/engineering-blog-journey-to-superhuman-performance-on-scientific-tasks))
- Multi-provider metadata: Crossref + Semantic Scholar + OpenAlex + Unpaywall with tiered early-stop; retraction detection. ([DeepWiki](https://deepwiki.com/Future-House/paper-qa/4.1-metadata-clients))
- Citation traversal: agent follows citations on ~46% of questions. ([Blog](https://www.futurehouse.org/research/engineering-blog-journey-to-superhuman-performance-on-scientific-tasks))
- Contradiction detection via prompt swap on same evidence pipeline. 2.34±1.99 contradictions/paper, 70% expert validation. ([Paper](https://arxiv.org/abs/2409.13740))

**Gap vs Trellis:**
- No LLM reranking before extraction — `src/research/passageSelection.ts` does lexical scoring + top-K only.
- No multi-provider source metadata — `src/graph/epistemics.ts` has static source authority.
- Contradiction detection is structural (Jaccard), not semantic.

**Recommendation:**
- LLM reranking pass in `src/research/passageSelection.ts` after lexical top-K. **Effort: medium** — needs cost/budget integration first.
- Source metadata hydration in `src/graph/epistemics.ts` via Crossref API. **Effort: medium.**
- LLM contradiction prompt in `src/graph/claimReconciler.ts`. **Effort: small.**

---

### 3. LangGraph (LangChain) — Durable/Resumable Execution, Pending Writes, HITL

**Verified Facts:**
- Checkpoints full graph state (channel values + versions) at every superstep, scoped by `thread_id`. ([Persistence Docs](https://docs.langchain.com/oss/python/langgraph/persistence))
- On node failure, successful parallel nodes' writes stored as **pending writes**; on resume, replayed and only failed node re-executes. ([Checkpoint README](https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/README.md))
- `interrupt(value)` saves state, pauses indefinitely; same `thread_id` + resume input replays from checkpoint. ([Interrupts Docs](https://docs.langchain.com/oss/python/langgraph/interrupts))
- Persistent backends: `SqliteSaver` (local), `PostgresSaver` (production). ([Persistence Docs](https://docs.langchain.com/oss/python/langgraph/persistence))

**Gap vs Trellis:**
- `src/research/scheduler.ts` — execution not resumable (RUN_FAILED with `recovery_unsupported`).
- `src/research/strategies/agentStrategy.ts` — no checkpointing of ReAct loop position; crash = full re-run.
- No HITL interrupt mechanism.

**Recommendation:**
- Persist execution spec + step checkpoint in `src/research/scheduler.ts` (iteration_index, completed_subquestions, pending_observations). **Effort: medium.**
- Pending-writes retention in `src/research/strategies/agentStrategy.ts`: persist raw results keyed by run_id + step_index. **Effort: small** (~50 lines).
- `interrupt()` primitive in `scheduler.ts` for mid-research pause/resume. **Effort: medium.**
- SQLite checkpoint table already viable — same DB. **Effort: small.**

---

### 4. STORM / Co-STORM (Stanford OVAL) — Perspective Decomposition, Simulated Conversation, Mind-Map

**Verified Facts:**
- Perspective-guided question generation: LLM generates persona labels, each conditions a question call. ([README](https://github.com/stanford-oval/storm/blob/main/README.md), [knowledge_curation.py](https://github.com/stanford-oval/storm/blob/main/knowledge_storm/storm_wiki/modules/knowledge_curation.py))
- `ConvSimulator`: up to `max_turn` rounds between `WikiWriter` and `TopicExpert`. Writer adapts from dialogue history. Ablation shows conversation removal hurts more than persona removal. ([knowledge_curation.py](https://github.com/stanford-oval/storm/blob/main/knowledge_storm/storm_wiki/modules/knowledge_curation.py), [Shao et al. NAACL 2024](https://arxiv.org/abs/2312.14211))
- Co-STORM `KnowledgeBase`: hierarchical tree of `KnowledgeNode`s. `InsertInformationModule` places info via LLM + vector similarity. `ExpandNodeModule` splits overcrowded nodes. ([DeepWiki Co-STORM](https://deepwiki.com/stanford-oval/storm/3-co-storm-collaborative-system))
- Co-STORM agent types: `CoStormExpert`, `Moderator` (questions from unused info), human. ([EMNLP 2024 Co-STORM paper](https://arxiv.org/abs/2408.15232))

**Gap vs Trellis:**
- No perspective/persona decomposition in `src/research/strategies/agentStrategy.ts`.
- No simulated adaptive follow-up conversation.
- No hierarchical mind-map — flat `rm_claims`/`rm_claim_relations`.

**Recommendation:**
- Persona-seeded perspective decomposition in `src/research/strategies/agentStrategy.ts`. **Effort: small** (prompt engineering).
- Simulated follow-up refinement loop (two-pass with gap analysis). **Effort: medium.**
- Lightweight hierarchical topic structure in `src/research/`. **Effort: medium-large.**
- Moderator-style gap-finding agent step in ReAct loop. **Effort: small.**

---

### 5. HippoRAG 2 (OSU-NLP-Group) — PPR Retrieval, Index Versioning, Continual Integration

**Verified Facts:**
- LLM-extracted open KG + Personalized PageRank for multi-hop associative retrieval. ([GitHub README](https://github.com/OSU-NLP-Group/HippoRAG/blob/main/README.md), [DeepWiki retrieval](https://deepwiki.com/OSU-NLP-Group/HippoRAG/3.4-retrieval-process))
- Continual indexing: incremental merge into existing KG + vector store. ([arXiv:2502.14802](https://arxiv.org/abs/2502.14802))
- `index_manifest.json` binds persisted state to model/endpoint identity; mismatched indexes rejected. ([GitHub README § Upgrading existing indexes](https://github.com/OSU-NLP-Group/HippoRAG/blob/main/README.md))
- DSPy-based recognition-memory reranker before PPR. ([DeepWiki retrieval](https://deepwiki.com/OSU-NLP-Group/HippoRAG/3.4-retrieval-process))

**Gap vs Trellis:**
- No graph-based multi-hop retrieval — all keyword/Jaccard.
- Zero vector embeddings anywhere.
- No index-versioning manifest — silent corruption risk on model-version mismatch.

**Recommendation:**
- `index_identity` manifest in `src/store/projectionBuilder.ts` on rebuild; warn on mismatch. **Effort: small.**
- PPR over `rm_claim_relations` in new `src/graph/pprRetrieval.ts`. **Effort: medium** (~100-line custom impl).
- Embeddings for reconciliation + passage scoring (blocked on vector infra). **Effort: large.**

---

### 6. LightRAG (HKUDS) — Pluggable Storage Abstraction, Incremental KG Merge

**Verified Facts:**
- Four storage abstractions: `BaseKVStorage`, `BaseVectorStorage`, `BaseGraphStorage`, `BaseDocStatusStorage` with string-name registry. ([AGENTS.md](https://github.com/HKUDS/LightRAG/blob/main/AGENTS.md), [ProgramingWithCore.md](https://github.com/HKUDS/LightRAG/blob/main/docs/ProgramingWithCore.md))
- Backends: KV (Json/PG/Redis/Mongo/OpenSearch), Vector (NanoVectorDB/PGVector/Milvus/Chroma/Faiss/Mongo/Qdrant/OpenSearch), Graph (NetworkX/Neo4j/PGGraph/AGE/OpenSearch). ([ProgramingWithCore.md](https://github.com/HKUDS/LightRAG/blob/main/docs/ProgramingWithCore.md))
- Postgres as all-in-one backend (KV + Vector + Graph + DocStatus). ([ProgramingWithCore.md](https://github.com/HKUDS/LightRAG/blob/main/docs/ProgramingWithCore.md))
- Graph entity/relation merging on insert (upsert + summary update). ([AGENTS.md](https://github.com/HKUDS/LightRAG/blob/main/AGENTS.md))

**Gap vs Trellis:**
- Single SQLite file; no pluggable storage tier.
- No incremental graph merge — Jaccard-only reconciliation.
- No vector index anywhere.

**Recommendation:**
- `DocStatusStore` abstraction in `src/store/` extracting existing event-based doc status. **Effort: small.**
- Embedding storage behind interface in `src/store/vectorStore.ts` (SQLite-vec). **Effort: medium.**
- Vector-similarity merge in `src/graph/claimReconciler.ts` with `CLAIM_MERGED` event. **Effort: medium-large.**
- Skip Neo4j for now; SQLite adjacency sufficient at current scale. **Effort: small.**

---

### 7. GPT Researcher (Assaf Elovic) — Parallel Fan-Out, Semaphore, Deep Research Recursion

**Verified Facts:**
- `generate_sub_queries()` produces N sub-queries via LLM. ([query_processing.py](https://raw.githubusercontent.com/assafelovic/gpt-researcher/main/gpt_researcher/actions/query_processing.py))
- Parallel dispatch via `asyncio.gather()` — each sub-query spawns independent `GPTResearcher`. ([researcher.py](https://raw.githubusercontent.com/assafelovic/gpt-researcher/main/gpt_researcher/skills/researcher.py))
- Deep Research: `asyncio.Semaphore(concurrency_limit)`, results include learnings + citations + follow-up questions, recursed to depth/breadth. ([deep_research.py](https://raw.githubusercontent.com/assafelovic/gpt-researcher/main/gpt_researcher/skills/deep_research.py))
- Aggregation: `ContextCompressor` (embedding similarity) + optional `SourceCurator` (LLM ranking). ([context_manager.py](https://raw.githubusercontent.com/assafelovic/gpt-researcher/main/gpt_researcher/skills/context_manager.py))
- LangGraph multi-agent variant: Editor → Researcher + Reviewer + Revisor → Writer. ([docs.gptr.dev](https://docs.gptr.dev/docs/gpt-researcher/multi_agents/langgraph))

**Gap vs Trellis:**
- No parallel sub-query fan-out — single ReAct loop, max 30 iterations.
- No structured aggregation layer between raw results and synthesis.
- No recursive depth/breadth control — flat iteration budget.

**Recommendation:**
- Sub-query planner in `src/research/strategies/agentStrategy.ts`. **Effort: small.**
- Parallel tool calls via `Promise.all` in agent strategy. **Effort: small.**
- Semaphore in `src/research/scheduler.ts` for per-run concurrency. **Effort: small.**
- Embedding re-ranking in `passageSelection.ts` (blocked on vector infra). **Effort: medium.**

---

### 8. Cognee (Topoteretes) — Triple-Store, Staged Memory, Ontology Extraction

**Verified Facts:**
- Triple-store: relational + vector + graph in one memory layer. Swappable backends. ([docs.cognee.ai/architecture](https://docs.cognee.ai/core-concepts/architecture))
- Staged lifecycle: session (Redis cache) → self-improvement → permanent (`cognify()`). `remember()` with `session_id` writes to session cache. ([docs.cognee.ai/remember](https://docs.cognee.ai/core-concepts/main-operations/remember), [cognee.ai/lifecycle](https://www.cognee.ai/ai-agent-memory-solutions-by-lifecycle))
- Ontology grounding: OWL ontologies or Pydantic DataPoint models guide extraction and canonicalization. ([docs.cognee.ai/ontology](https://docs.cognee.ai/guides/ontology-support))
- Temporal extraction: `temporal_cognify=True` for valid-time alongside ingestion-time. ([cognee/skill.md](https://github.com/topoteretes/cognee/blob/main/cognee/skill.md))

**Gap vs Trellis:**
- Zero embeddings / no vector index.
- No staged memory promotion — uniform event append.
- No ontology-guided extraction.

**Recommendation:**
- Embeddings in `src/graph/claimReconciler.ts` (local model). **Effort: medium.**
- Session-memory fast path in `src/store/events.ts` (in-memory Map or temp-table). **Effort: small.**
- Ontology schema for `src/research/claimExtraction.ts` (structured prompt + JSON schema). **Effort: medium.**
- Bi-temporal fields (large, long-term; overlaps with Graphiti rec). **Effort: large.**

---

### 9. KAG / OpenSPG — Logical-Form Reasoning, Schema-Constrained Construction

**Verified Facts:**
- Logical-form-guided hybrid reasoning: planner decomposes NL into operators combining graph traversal + text retrieval + numerical calculation. ([README](https://github.com/OpenSPG/kag), [arXiv:2409.13731](https://arxiv.org/abs/2409.13731))
- `SPGAligner`: conceptual semantic reasoning aligns OpenIE triples against ontology. ([DeepWiki overview](https://deepwiki.com/OpenSPG/KAG/1-overview))
- Schema-constrained construction: domain schema constrains extraction to predefined entity/relation types. ([Release notes v0.8](https://openspg.github.io/v2/blog/recent_posts/release_notes/0.8))
- Multi-hop benchmarks: +19.6% F1 on 2Wiki, +33.5% F1 on HotpotQA. ([arXiv:2409.13731](https://arxiv.org/abs/2409.13731))

**Gap vs Trellis:**
- No ontology/schema layer — pure Jaccard + fixed thresholds.
- No logical-form intermediate representation — ReAct only.
- No hybrid graph+vector retrieval.

**Recommendation:**
- Lightweight claim-type ontology (`claim_type`/`relation_type` enum in `rm_claims`/`rm_claim_relations` schema + `src/store/schema.ts`). **Effort: small.**
- Logical-form decomposition in `agentStrategy.ts` (medium-term, after embeddings).
- Semantic alignment in `claimReconciler.ts` (blocked on embeddings). **Effort: large.**
- Hybrid retrieval in `passageSelection.ts` (blocked on embeddings). **Effort: medium.**

---

### 10. Letta (Letta Code) — Stateful Memory, Git-Backed Context, Memory Interaction UX

**Verified Facts:**
- MemFS: all agent memory projected as Markdown+YAML files in per-agent git repo. Agent reads/writes via filesystem tools; commits = persistent memory. ([blog](https://www.letta.com/blog/context-repositories/), [docs](https://docs.letta.com/concepts/memfs/))
- Three-tier memory: (a) recall — immutable history, (b) core — editable blocks in system prompt, (c) external — skills + Markdown loaded on demand via progressive disclosure. ([letta-code/letta.md](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md))
- UX: `/search` messages, recall subagent, `memory` tool edits, `/doctor` audit, `/sleeptime` background reflection in git worktree. ([GitHub](https://github.com/letta-ai/letta-code))
- Identity = tokens, not model: agent persists across model swaps. ([letta-code/letta.md](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md))
- Progressive disclosure: `system/` always in context; rest discoverable via file tree + `[[path]]` synapses. ([blog](https://www.letta.com/blog/context-repositories/))

**Gap vs Trellis:**
- No user-facing "why do you think that" / provenance drill-down — memory is opaque read-model rows.
- No background consolidation — `src/store/checkpoints.ts` retains 3 checkpoints but doesn't reflect or reorganize.
- No agent-controlled context assembly — fixed top-K in `passageSelection.ts`.

**Recommendation:**
- Agent-authored memory files in new `src/memory/` module — Markdown summaries per Family/Thread. **Effort: small.**
- Background consolidation subagent in new `src/research/consolidation.ts`. **Effort: medium.**
- `explain(claimId)` endpoint in `src/query/longitudinal.ts` — full evidence chain + confidence breakdown. **Effort: small.**

---

## Suggested Sequencing

1. **Bi-temporal columns + contradiction invalidation events** (Graphiti) — smallest migration, largest correctness gain; Trellis's event-sourced architecture already supports it.

2. **LLM reranking pass in passageSelection** (PaperQA2) — single highest-accuracy ROI; costs one LLM call per passage batch, needs budget gating.

3. **Step-level checkpointing + pending-writes retention** (LangGraph) — makes ReAct migration crash-resilient; SQLite checkpoint table is a direct lift.

4. **Perspective seeding + moderator gap-finding in agentStrategy** (STORM) — improves subquestion breadth with prompt-only changes, no new infra.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Created docs/research-roadmap.md with exactly the requested structure: framing paragraph, priority-ranked table, 10 per-project detail sections, suggested sequencing. No scope widening."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "All facts sourced directly from the 10 provided research briefs with preserved citations. File content verifiable via read tool. No invented facts."
    }
  ],
  "changedFiles": [
    "docs/research-roadmap.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "ls docs/",
      "result": "passed",
      "summary": "Confirmed docs/ directory exists before writing"
    }
  ],
  "validationOutput": [
    "File written successfully. Structure matches spec: framing, table, 10 subsections, sequencing list, acceptance block."
  ],
  "residualRisks": [
    "Research briefs reference Trellis file paths from task descriptions, not verified against actual repo structure in this session",
    "Effort tiers are researcher estimates, not validated against actual code complexity"
  ],
  "noStagedFiles": true,
  "diffSummary": "New file: docs/research-roadmap.md — comprehensive roadmap document synthesizing 10 research briefs into prioritized recommendations",
  "reviewFindings": [
    "no blockers — document faithfully reflects research briefs without invention"
  ],
  "manualNotes": "All 10 research briefs used verbatim. No facts beyond the briefs were added. Citations preserved as-is from researcher outputs."
}
```