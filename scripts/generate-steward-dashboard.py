#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path("/home/dzack/gitclones/chat-on-steroids")
REPOS = {
    "research": Path("/home/dzack/research"),
    "lean-categories": Path("/home/dzack/gitclones/lean-categories"),
    "new-qual-site": Path("/home/dzack/gitclones/new-qual-site"),
    "sage-categories": Path("/home/dzack/gitclones/sage-categories"),
}

REPO_COPY = {
    "research": {
        "objective": "Refactor the mathematical preamble so public operations live on the mathematical objects and categories that own them, then re-run the public Sage session against the repaired architecture.",
        "progress": "Architecture repair work",
    },
    "lean-categories": {
        "objective": "Realize the minimized source-faithful definition frontier in Lean, source by source, now that prior-art discovery is complete.",
        "progress": "Definition realization",
    },
    "new-qual-site": {
        "objective": "Finish the post-publication Author-solutions DAG by writing and banking complete source-faithful proofs one problem card at a time.",
        "progress": "Author solutions",
    },
    "sage-categories": {
        "objective": "Finish framework completion by validating the integrated static projection at exact current HEAD through the repository-defined public consumers, then close final delivery.",
        "progress": "Current-head acceptance",
    },
}

LEAN_SOURCE_TITLES = {
    "01": "Dummit–Foote, Abstract Algebra",
    "02": "Munkres, Topology",
    "03": "Riehl, Category Theory in Context",
    "04": "Atiyah–Macdonald, Introduction to Commutative Algebra",
    "05": "Weibel, An Introduction to Homological Algebra",
    "06": "Hartshorne, Algebraic Geometry",
    "07": "Hatcher, Algebraic Topology",
    "08": "Lee, Introduction to Smooth Manifolds",
    "09": "Neukirch, Algebraic Number Theory",
    "10": "Serre, Local Fields",
    "11": "Peters–Sterk, Symmetric and Quadratic Forms",
    "12": "Beauville, Complex Algebraic Surfaces",
    "13": "Matsumura, Commutative Ring Theory",
    "14": "Humphreys, Introduction to Lie Algebras and Representation Theory",
    "15": "Humphreys, Reflection Groups and Coxeter Groups",
    "16": "Humphreys, Linear Algebraic Groups",
    "17": "Lurie, Kerodon",
}

RESEARCH_MANAGER_COPY = {
    "terminal-session": "Run the repaired public Sage session and notebook examples end to end, then verify that the displayed mathematical objects and maps are correct.",
    "research-sage-runtime": "Restore the repository's supported Sage runtime after the source-level architecture repairs are complete.",
    "owner-api-convergence": "Move public mathematical operations from free functions onto the objects, morphisms, categories, or functors that mathematically own them, and remove obsolete global entry points.",
    "framing-primary-epi": "Represent a framed module by its actual chosen surjection from a free module, so generators and the framing map are projections of one construction.",
    "framing-specialization-convergence": "Make lattices, presented modules, fractional ideals, group modules, and related specializations reuse the same underlying framing construction instead of rebuilding it locally.",
    "owned-provenance-data": "Replace hidden source/provenance attributes with explicit mathematical construction data wherever later operations genuinely depend on a chosen source or comparison map.",
    "refinement-convergence": "Construct standard mathematical structure at object creation time instead of installing it later through order-dependent runtime refinement.",
    "generator-lexicon": "Make public generator displays describe the mathematical generator set or image rather than the Python mechanism storing it.",
    "ambiguous-generator-names": "Replace ambiguous public names such as bare gens, basis, or dual with names that state which mathematical structure is meant.",
    "categorical-representation-convergence": "Use one authoritative representation for equivalent categorical data such as contravariant functors, bifunctors, and adjunction data, deriving the other views mechanically.",
    "owned-product-codomains": "Return mathematical product objects from public APIs instead of exposing Python tuples or lists as the mathematical result.",
    "mathematical-return-types": "Give public operations mathematical return types rather than generic framework types after their APIs have stabilized.",
    "assertion-frontiers": "Replace generic not-implemented control flow with precise supported mathematical domains and explicit unsupported computational boundaries.",
    "placeholder-stubs": "Remove unconditional public placeholders so every mathematical operation either works on a stated domain or is an explicit abstract contract.",
    "group-module-scalar-change-convergence": "Make scalar extension and restriction of group modules one construction that owns both object and morphism transport.",
    "memoization-convergence": "Move theory-specific identity caches onto the shared construction-identity mechanism without identifying genuinely different mathematical choices.",
    "singular-kernel-delegation": "Delegate finitely presented module kernel computations to the maintained Sage/Singular operation rather than reproducing the algorithm in Python orchestration.",
    "torsion-action-delegation": "Route torsion-form orbit and stabilizer computations through the general group-action interface, with GAP hidden behind that owner.",
    "imperative-algorithm-cleanup": "Replace remaining generic hand-written traversal, grouping, and multiplication algorithms with their mathematical or mature-library owners where such an owner exists.",
    "coordinate-firewall": "Keep coordinate/storage views only where a chosen finite presentation makes them mathematical data; ordinary public interaction should use semantic objects and maps.",
    "ownership-test-contract": "Update tests so they prove the owner-based public API directly instead of silently reinstalling removed compatibility globals.",
    "canonical-notebook-contract": "Rewrite the main research notebook around mathematical questions and executable claims using the repaired public API, then execute it during terminal verification.",
    "architecture-remediation": "Complete all architecture repairs found by the repository-wide audit and close each finding at its mathematical owner before terminal verification.",
    "refactor-audit": "After the repaired architecture passes the public session, inspect the repository for duplicated or disorganized internal sources of truth and repair concrete findings.",
    "type-paydown": "Improve useful static typing after the architecture settles, without distorting the mathematical API merely to satisfy the checker.",
    "bloat-audit-loop": "Run the repository's final source-aware quality review after all required implementation and verification work is complete.",
}

NEW_QUAL_MANAGER_COPY = {
    "policy-consolidation": "Keep one authoritative editorial and contribution guide for the problem archive, with obsolete duplicate policy documents removed.",
    "copy-policy-repair": "Read the existing reader-facing site copy against the current editorial standards and rewrite every violating passage without changing its mathematics.",
    "pdf-source-intake": "Finish processing every remaining source PDF into source-faithful problem records or justified reference material so the archive's problem population is stable.",
    "math-defect-repair": "Resolve every known incorrect mathematical statement, proof, title, or source transcription against the original source.",
    "merged-proof-adjudication": "Mathematically review competing proofs created by branch consolidation and retain or combine the correct proof for each affected problem.",
    "ag-notes-migration": "Finish migrating the remaining algebraic-geometry study notes into the site's definitions, theorems, examples, and reference pages.",
    "tooling-remediation": "Fix the known authoring, validation, and rendering defects that can let broken mathematical content pass or display incorrectly.",
    "complaints-clearance": "Resolve every currently recorded site or content defect at its owning source before publication.",
    "publication-milestone": "Publish a revision only after source intake, mathematical repairs, copy repair, note migration, tooling repairs, and the known defect list are all complete.",
    "select": "Choose the next source-ordered problem that still lacks a solution.",
    "read": "Read the selected problem together with its original source before proving it.",
    "prove": "Write a complete mathematical proof for the selected problem.",
    "attach": "Attach that proof to the problem card in the archive's required structured format.",
    "source-review": "Compare any source-provided solution only after independently reading the problem, incorporating only mathematically justified improvements.",
    "commit": "Review the finished proof for correctness and source fidelity, then bank that one solved problem before choosing another.",
}


def manager_task(repo_name: str, ident: str, fallback: str, raw: str = "") -> str:
    """Return presentation copy that makes sense without repository-local vocabulary."""
    if repo_name == "research":
        return RESEARCH_MANAGER_COPY.get(ident, fallback)
    if repo_name == "new-qual-site":
        return NEW_QUAL_MANAGER_COPY.get(ident, fallback)
    if repo_name == "lean-categories":
        source = re.match(r"fc(\d{2})-(mapping|definition-residue-pass2|definitions)$", ident)
        if source:
            title = LEAN_SOURCE_TITLES.get(source.group(1), "the selected reference text")
            phase = source.group(2)
            if phase == "mapping":
                return f"Locate and verify existing formalizations for every indexed definition in {title}."
            if phase == "definition-residue-pass2":
                return f"Run a broader second prior-art search for definitions in {title} that still lack a located implementation."
            return f"Implement the definitions from {title} that remain after prior-art search, preserving the complete source meaning."
        fixed = {
            "corpus": "Maintain the admitted reference-text corpus and its explicit source scope.",
            "catalogue": "Index every mathematical item in the admitted reference texts before filtering by implementation availability.",
            "mapping": "Locate and verify existing formalizations for indexed mathematics before writing project-local replacements.",
            "definition-mapping-convergence": "Finish prior-art discovery for every indexed definition before any new definition is authored.",
            "definitions": "Implement only the definitions that remain after prior-art discovery, preserving their complete source meaning and intrinsic laws.",
            "definition-realization-convergence": "Verify that every indexed definition now has a usable, source-faithful Lean realization.",
            "audit-authored-definitions": "Replace locally authored definitions with verified existing implementations wherever the prior-art audit found one.",
            "definition-positive-route-audit": "Recheck every claimed existing implementation against the complete textbook definition and the actual referenced declaration.",
            "definition-residue-pass2": "Combine the source-by-source second searches and return any unresolved first-pass gaps to the appropriate source review.",
            "definition-open-ended-prior-art-search": "Run one final unconstrained search across formalization projects and package ecosystems for any remaining definition before authoring it locally.",
            "definition-source-conformance": "Compare every realized definition with its original textbook statement, including all data, hypotheses, equations, and intrinsic laws.",
            "theorems": "Formalize the remaining theorem statements after the definitional layer is complete.",
            "arithmetic-lattice-foundations": "Build the general arithmetic-lattice foundations required by later project mathematics after the reference-text programme is complete.",
            "refactor-audit": "Consolidate duplicated or misplaced Lean after the mathematical corpus work is complete.",
            "lint-paydown": "Resolve useful linter findings that improve mathematical legibility without contorting statements merely to silence tools.",
            "bloat-audit-loop": "Run the final source-aware quality review after the required mathematical and refactoring work is complete.",
        }
        return fixed.get(ident, fallback)
    return public_task(raw, fallback)

WINDOWS = [
    ("1h", 3600),
    ("6h", 6 * 3600),
    ("12h", 12 * 3600),
    ("18h", 18 * 3600),
    ("1d", 24 * 3600),
    ("3d", 3 * 86400),
    ("7d", 7 * 86400),
    ("14d", 14 * 86400),
    ("1mo", 30 * 86400),
    ("all", None),
]


def run(repo: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        args,
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and proc.returncode:
        raise RuntimeError(f"{' '.join(args)}: {proc.stderr.strip()}")
    return proc.stdout


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(repo, "git", *args, check=check)


def parse_iso(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def plain(text: str) -> str:
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*+", "", text)
    text = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip(" -.:")
    return text


def public_task(text: str, fallback: str) -> str:
    """Extract manager-facing work description; never expose the scheduling identifier."""
    text = plain(text)
    text = re.sub(r"^Needs:\s*[^.]*\.\s*", "", text, flags=re.I)
    text = re.sub(r"^(Closed|Completed)(?:\s+[^.]*)?\.\s*", "", text, flags=re.I)
    text = re.sub(r"^Terminal convergence loop;?\s*", "", text, flags=re.I)
    text = re.sub(r"\bFC\d{2}(?:-[A-Z0-9]+)*\b", "the current textbook source", text)
    text = re.sub(r"\bU\d{3}\b", "the current item", text)
    text = re.sub(r"\bQueue [A-Z]\b", "the generated work list", text)
    text = re.sub(r"\bMilestone \d+\b", "the current phase gate", text)
    text = re.sub(r"\bfrontier\b", "remaining eligible work", text, flags=re.I)
    text = re.sub(r"\bresidue\b", "unresolved prior-art search", text, flags=re.I)
    text = re.sub(r"\bcanonical\b", "established", text, flags=re.I)
    text = re.sub(r"\b(?:ARC|API|STY|OWN|LEX|CON|CAT|SET|DEV|ENG|BND)-\d+(?:--\d+)?\b", "", text)
    text = re.sub(r"(?:,\s*){2,}", ", ", text)
    text = re.sub(r"\s+", " ", text).strip(" ,;:. ")
    if not text or len(text) < 18:
        return fallback
    # The first two prose sentences are enough to explain the work without leaking
    # the repository's worker-management contract into the owner dashboard.
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(sentences[:2]).strip()


def commits(repo: Path) -> list[dict[str, object]]:
    # Prefix each commit record separator so its following --numstat lines stay
    # in the same block.  A trailing separator splits metadata from its own diff.
    fmt = "%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%s"
    raw = git(repo, "log", f"--format={fmt}", "--numstat")
    out: list[dict[str, object]] = []
    for block in raw.split("\x1e"):
        block = block.strip("\n")
        if not block.strip():
            continue
        lines = block.splitlines()
        meta = lines[0].split("\x1f")
        if len(meta) < 5:
            continue
        insertions = deletions = files = 0
        for line in lines[1:]:
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            files += 1
            if parts[0].isdigit():
                insertions += int(parts[0])
            if parts[1].isdigit():
                deletions += int(parts[1])
        out.append(
            {
                "hash": meta[0][:9],
                "time": meta[1],
                "author": meta[2],
                "email": meta[3],
                "subject": meta[4],
                "files": files,
                "insertions": insertions,
                "deletions": deletions,
            }
        )
    return out


def recent_files(repo: Path, limit: int = 80) -> list[dict[str, object]]:
    names = git(repo, "ls-files", "-co", "--exclude-standard").splitlines()
    rows: list[tuple[float, str]] = []
    for name in names:
        path = repo / name
        try:
            stamp = path.stat().st_mtime
        except OSError:
            continue
        rows.append((stamp, name))
    rows.sort(reverse=True)
    return [
        {
            "time": dt.datetime.fromtimestamp(stamp, dt.timezone.utc).isoformat(),
            "path": name,
        }
        for stamp, name in rows[:limit]
    ]


def dirty(repo: Path) -> dict[str, object]:
    lines = git(repo, "status", "--short").splitlines()
    by_status: dict[str, int] = {}
    for line in lines:
        code = line[:2]
        by_status[code] = by_status.get(code, 0) + 1
    return {"count": len(lines), "by_status": by_status}


def checkbox_dag(path: Path, fallback: str, repo_name: str) -> list[dict[str, object]]:
    text = path.read_text(errors="replace").splitlines()
    nodes: list[dict[str, object]] = []
    pat = re.compile(r"^- \[([ x])\] \*\*`([^`]+)`\*\*\. \*\*Needs:\*\* (.*)")
    optional_cut = next(
        (i for i, line in enumerate(text) if repo_name == "research" and line.startswith("## Optional research consumers")),
        len(text),
    )
    for index, line in enumerate(text):
        if index >= optional_cut:
            break
        match = pat.match(line)
        if not match:
            continue
        closed = match.group(1) == "x"
        ident = match.group(2)
        tail = match.group(3)
        needs = [] if re.match(r"none\.?$", tail.strip()) else re.findall(r"`([^`]+)`", tail.split(".", 1)[0])
        body = [tail.split(". ", 1)[1] if ". " in tail else ""]
        cursor = index + 1
        while cursor < len(text) and not pat.match(text[cursor]) and not re.match(r"^#{1,4} ", text[cursor]):
            if text[cursor].strip():
                body.append(text[cursor])
            cursor += 1
        raw = " ".join(body)
        description = manager_task(repo_name, ident, fallback, raw)
        nodes.append({"id": ident, "closed": closed, "needs": needs, "public": description})
    return nodes


def new_qual_dag(path: Path, fallback: str) -> list[dict[str, object]]:
    """Read both the publication DAG and the per-problem solution DAG.

    The publication programme deliberately uses prose bullets whose completion
    state is the leading ``Closed <date>.`` sentence, while the repeated
    solution state machine uses checkboxes.  Treating the file as a checkbox
    list hides the entire publication programme from the owner dashboard.
    """
    text = path.read_text(errors="replace").splitlines()
    nodes: list[dict[str, object]] = []
    milestone_start = next(
        (i for i, line in enumerate(text) if line.startswith("### Milestone:")),
        next(i for i, line in enumerate(text) if line.startswith("### Current route")),
    )
    solutions_start = next(i for i, line in enumerate(text) if line.startswith("### Solutions after the milestone"))
    bullet = re.compile(r"^- \*\*`([^`]+)`\*\*\.\s*(.*)")
    for index in range(milestone_start, solutions_start):
        match = bullet.match(text[index])
        if not match:
            continue
        ident, opening = match.groups()
        cursor = index + 1
        body = [opening]
        while cursor < solutions_start and not bullet.match(text[cursor]):
            if text[cursor].strip():
                body.append(text[cursor])
            cursor += 1
        raw = " ".join(body)
        needs_match = re.search(r"\*\*Needs:\*\*\s*([^.]*)", raw)
        needs_text = needs_match.group(1).strip() if needs_match else "none"
        needs = [] if needs_text.lower() == "none" else re.findall(r"`([^`]+)`", needs_text)
        closed = bool(re.match(r"\*\*Closed\b", opening))
        nodes.append(
            {
                "id": ident,
                "closed": closed,
                "needs": needs,
                "public": manager_task("new-qual-site", ident, public_task(raw, fallback), raw),
            }
        )
    # The stable per-card state machine is retained below the publication
    # milestone and should appear only with its real prerequisite edges.
    nodes.extend(checkbox_dag(path, fallback, "new-qual-site"))
    return nodes


def table_dag(path: Path, fallback: str, repo_name: str) -> list[dict[str, object]]:
    nodes: list[dict[str, object]] = []
    for line in path.read_text(errors="replace").splitlines():
        if not line.startswith("| `"):
            continue
        cols = [item.strip() for item in line.strip().strip("|").split("|")]
        if len(cols) < 3:
            continue
        ident = cols[0].strip("`")
        description = cols[1]
        needs = re.findall(r"`([^`]+)`", cols[2])
        closed = "**Closed" in description or "**Completed" in description or "Completed " in description
        public = manager_task(repo_name, ident, fallback, description)
        nodes.append(
            {
                "id": ident,
                "closed": closed,
                "needs": needs,
                "public": public,
            }
        )
    return nodes


def open_ready(nodes: list[dict[str, object]]) -> dict[str, int]:
    open_ids = {str(node["id"]) for node in nodes if not node["closed"]}
    for node in nodes:
        node["ready"] = (not node["closed"]) and all(str(dep) not in open_ids for dep in node["needs"])
    return {
        "open": sum(not bool(node["closed"]) for node in nodes),
        "closed": sum(bool(node["closed"]) for node in nodes),
        "ready": sum(bool(node.get("ready")) for node in nodes),
    }


def process_rows(repo: Path) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        proc = Path("/proc") / entry
        try:
            cwd = Path(os.readlink(proc / "cwd"))
            if cwd != repo and repo not in cwd.parents:
                continue
            cmd = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace").strip()
            state = (proc / "stat").read_text().split()[2]
        except Exception:
            continue
        if cmd:
            rows.append(
                {
                    "pid": int(entry),
                    "state": state,
                    "cwd": str(cwd.relative_to(repo)) if cwd != repo else ".",
                    "cmd": cmd[:240],
                }
            )
    return rows[:40]


def lean_progress(repo: Path, dag: list[dict[str, object]]) -> dict[str, object]:
    """Report the current Sweep-III source, not the already-closed mapping phase."""
    current = next(
        (
            str(node["id"])
            for node in dag
            if not node["closed"] and re.fullmatch(r"fc\d{2}-definitions", str(node["id"]))
        ),
        None,
    )
    if current is None:
        return {
            "headline": "The source-by-source definition realization frontier is closed",
            "detail": "No FCxx definition-realization node remains open in the current TODO dependency table.",
            "remaining": 0,
            "total": 0,
        }
    source = current[2:4]
    text = (repo / "FOUNDATIONAL_FRONTIER.md").read_text(errors="replace")
    section = re.search(
        rf"^## FC{source} — Definitions\n(?P<body>.*?)(?=^## |\Z)",
        text,
        re.MULTILINE | re.DOTALL,
    )
    if section is None:
        raise RuntimeError(f"FOUNDATIONAL_FRONTIER.md has no FC{source} Definitions section")
    counts = re.search(
        r"Delivered/directly reusable by mapping: \*\*(\d+)/(\d+)\*\*; pending realization: \*\*(\d+)\*\*",
        section.group("body"),
    )
    if counts is None:
        raise RuntimeError(f"FC{source} Definitions section has no realization count")
    delivered, total, remaining = map(int, counts.groups())
    return {
        "headline": f"FC{source}: {remaining:,} definition realizations remain",
        "detail": f"{delivered:,} of {total:,} FC{source} definitions are delivered or directly reusable by the current mapping. This is the active Sweep-III source; later sources remain serialized by the TODO DAG.",
        "remaining": remaining,
        "total": total,
    }


def nq_progress(repo: Path) -> dict[str, object]:
    queue = (repo / "queues/C-unsolved-cards.md").read_text(errors="replace")
    ids = set(re.findall(r"\b(?:P|E)-[A-Za-z0-9_.-]+\b", queue))
    source_rows = (repo / "queues/E-pdf-attachments.md").read_text(errors="replace").splitlines()
    open_sources = [line for line in source_rows if line.startswith("- [ ]")]
    blocked = sum("BLOCKED" in line for line in open_sources)
    return {
        "headline": f"{len(ids):,} problem cards still lack a solution",
        "detail": f"Source intake has {len(open_sources) - blocked} currently executable PDF rows and {blocked} source-local blockers. New source intake can add unsolved cards, so net queue change is not gross solution throughput.",
        "remaining": len(ids),
        "source_open": len(open_sources),
        "source_blocked": blocked,
    }


def research_progress(summary: dict[str, int]) -> dict[str, object]:
    return {
        "headline": f"{summary['ready']} architecture repairs are unblocked",
        "detail": f"{summary['open']} repair or verification tasks remain in the dependency graph. An unblocked task has no unfinished prerequisites; task size is independent of that status.",
        "remaining": summary["open"],
    }


def sage_progress(summary: dict[str, int]) -> dict[str, object]:
    if summary["open"] == 0:
        return {
            "headline": "Required implementation and acceptance work is complete",
            "detail": "The execution plan has no open required tasks. Future implementation restarts only for a concrete regression, newly requested capability, or another substantive repository-defined requirement.",
            "remaining": 0,
        }
    return {
        "headline": f"{summary['open']} required implementation or verification tasks remain",
        "detail": "These are explicit execution-plan tasks, not periodic review activity.",
        "remaining": summary["open"],
    }


def queue_history(repo: Path, limit: int = 240) -> list[dict[str, object]]:
    raw = git(repo, "log", f"-n{limit}", "--format=%H%x1f%aI", "--", "queues/C-unsolved-cards.md")
    points: list[dict[str, object]] = []
    seen: set[int] = set()
    for line in raw.splitlines():
        if "\x1f" not in line:
            continue
        revision, when = line.split("\x1f", 1)
        # At most one expensive historical queue read per 15-minute bucket.
        bucket = int(parse_iso(when).timestamp() // 900)
        if bucket in seen:
            continue
        seen.add(bucket)
        queue = git(repo, "show", f"{revision}:queues/C-unsolved-cards.md", check=False)
        if not queue:
            continue
        count = len(set(re.findall(r"\b(?:P|E)-[A-Za-z0-9_.-]+\b", queue)))
        points.append({"time": when, "remaining": count, "revision": revision[:9]})
    points.sort(key=lambda point: str(point["time"]))
    return points


def repo_payload(name: str, repo: Path, classification: str) -> dict[str, object]:
    copy = REPO_COPY[name]
    fallback = copy["objective"]
    if name == "new-qual-site":
        dag = new_qual_dag(repo / "TODO.md", fallback)
    elif name == "research":
        dag = checkbox_dag(repo / "TODO.md", fallback, name)
    else:
        dag = table_dag(repo / "TODO.md", fallback, name)
    summary = open_ready(dag)
    if name == "lean-categories":
        progress = lean_progress(repo, dag)
    elif name == "new-qual-site":
        progress = nq_progress(repo)
    elif name == "research":
        progress = research_progress(summary)
    else:
        progress = sage_progress(summary)
    return {
        "name": name,
        "objective": copy["objective"],
        "progress_label": copy["progress"],
        "path": str(repo),
        "head": git(repo, "rev-parse", "--short", "HEAD").strip(),
        "classification": classification,
        "dirty": dirty(repo),
        "processes": process_rows(repo),
        "commits": commits(repo),
        "files": recent_files(repo),
        "dag": dag,
        "dag_summary": summary,
        "progress": progress,
        "remaining_history": queue_history(repo) if name == "new-qual-site" else [],
    }


CSS = r"""
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#1f2328;background:#f6f8fa;--border:#d0d7de;--muted:#656d76;--green:#1a7f37;--red:#cf222e;--orange:#9a6700}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1700px;margin:auto;padding:12px}.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-end;margin-bottom:8px}.top h1{font-size:21px;margin:0}.muted{color:var(--muted)}.windows{display:flex;gap:3px;flex-wrap:wrap;margin:8px 0 12px}.windows button{font:inherit;font-size:11px;padding:4px 8px;border:1px solid var(--border);background:white;border-radius:6px;cursor:pointer}.windows button.on{background:#24292f;color:white;border-color:#24292f}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.repo{background:white;border:1px solid var(--border);border-radius:9px;overflow:hidden}.rh{display:grid;grid-template-columns:1fr auto;gap:8px;padding:9px 11px;border-bottom:1px solid #eaeef2}.rh .objective{font-size:11px;color:var(--muted);margin-top:3px;max-width:900px}.state{font-weight:700;font-size:12px;align-self:start}.working{color:var(--green)}.blocked,.wedged,.drifting{color:var(--orange)}.done{color:var(--muted)}.activity{padding:9px 10px 6px}.rate-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:4px}.rate{border:1px solid #eaeef2;border-radius:7px;padding:6px 8px}.rate b{display:block;font-size:18px;font-variant-numeric:tabular-nums}.rate span{font-size:10px;color:var(--muted)}.rate .plus{color:var(--green)}.rate .minus{color:var(--red)}.chart{height:128px}.chart svg{width:100%;height:100%;display:block}.section-title{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 5px}.tails{display:grid;grid-template-columns:1.2fr .8fr;border-top:1px solid #eaeef2}.tail-panel{min-width:0;padding:8px}.tail-panel+ .tail-panel{border-left:1px solid #eaeef2}.tail{max-height:180px;overflow:auto}.row{display:grid;grid-template-columns:84px 1fr;gap:7px;padding:5px 3px;border-bottom:1px solid #f0f2f4;font-size:11px}.row .when{font-variant-numeric:tabular-nums;color:var(--muted)}.row .subject{min-width:0}.diff{display:flex;gap:8px;margin-top:2px;color:var(--muted);font-size:10px}.diff .plus{color:var(--green);font-weight:600}.diff .minus{color:var(--red);font-weight:600}.progress{border-top:1px solid #eaeef2;padding:8px 10px}.progress-head{font-size:17px;font-weight:650}.progress-detail{font-size:11px;color:var(--muted);margin-top:2px}.remaining-chart{height:100px;margin-top:4px}.dagwrap{border-top:1px solid #eaeef2;padding-top:7px}.dagtitle{padding:0 10px 4px;display:flex;justify-content:space-between;gap:8px}.dagbox{height:205px;position:relative}.dagbox svg{width:100%;height:100%;touch-action:none}.tip{position:fixed;z-index:100;max-width:min(440px,calc(100vw - 20px));max-height:min(300px,calc(100vh - 20px));overflow:auto;padding:8px 10px;border-radius:7px;background:#24292f;color:white;font-size:11px;line-height:1.35;pointer-events:none;opacity:0;box-shadow:0 4px 16px #0004}.pill{font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:999px;color:var(--muted)}.meta{font-size:10px;color:var(--muted);padding:0 10px 8px}.foot{font-size:10px;color:var(--muted);margin-top:8px}@media(max-width:1000px){.grid{grid-template-columns:1fr}.tails{grid-template-columns:1fr}.tail-panel+.tail-panel{border-left:0;border-top:1px solid #eaeef2}}@media(max-width:580px){.rate-strip{grid-template-columns:1fr 1fr 1fr}.rate b{font-size:15px}.row{grid-template-columns:70px 1fr}.wrap{padding:7px}}
"""


JS = r"""
const DATA=window.__DATA__;
const WINDOWS=window.__WINDOWS__;
let active='6h';
const fmtTime=s=>new Date(s).toLocaleString([], {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const ago=s=>{const m=Math.max(0,Math.round((Date.now()-new Date(s))/60000));return m<60?`${m}m ago`:m<1440?`${Math.round(m/60)}h ago`:`${Math.round(m/1440)}d ago`};
const windowSeconds=()=>WINDOWS.find(d=>d[0]===active)[1];
function selected(commits){const sec=windowSeconds();if(sec===null)return commits;const cut=Date.now()-sec*1000;return commits.filter(c=>new Date(c.time).getTime()>=cut)}
function spanHours(commits){const sec=windowSeconds();if(sec!==null)return sec/3600;if(!commits.length)return 1;const first=new Date(commits[commits.length-1].time).getTime();return Math.max(1,(Date.now()-first)/3600000)}
function bucket(commits){const xs=selected(commits);let sec=windowSeconds();if(sec===null){if(!xs.length)return[];sec=Math.max(3600,(Date.now()-new Date(xs[xs.length-1].time))/1000)}const target=42;const bw=Math.max(300,sec/target);const end=Date.now()/1000,start=end-sec;const n=Math.max(1,Math.ceil(sec/bw));const bins=Array.from({length:n},(_,i)=>({t:(start+(i+.5)*bw)*1000,commits:0,ins:0,del:0,hours:bw/3600}));xs.forEach(c=>{const k=Math.floor((new Date(c.time).getTime()/1000-start)/bw);if(k>=0&&k<n){bins[k].commits++;bins[k].ins+=c.insertions;bins[k].del+=c.deletions}});return bins.map(b=>({...b,cr:b.commits/b.hours,ir:b.ins/b.hours,dr:b.del/b.hours}))}
function rateChart(el,commits){el.innerHTML='';const arr=bucket(commits);if(!arr.length){el.textContent='No commits in this window';return}const w=720,h=124,p={l:30,r:30,t:8,b:18};const svg=d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`);const x=d3.scaleTime().domain(d3.extent(arr,d=>new Date(d.t))).range([p.l,w-p.r]);const yc=d3.scaleLinear().domain([0,d3.max(arr,d=>d.cr)||1]).nice().range([56,p.t]);const yl=d3.scaleLinear().domain([0,d3.max(arr,d=>Math.max(d.ir,d.dr))||1]).nice().range([h-p.b,67]);svg.selectAll('line.c').data(arr).join('line').attr('x1',d=>x(new Date(d.t))).attr('x2',d=>x(new Date(d.t))).attr('y1',yc(0)).attr('y2',d=>yc(d.cr)).attr('stroke','#8c959f').attr('stroke-width',Math.max(1,Math.min(6,(w-p.l-p.r)/arr.length*.58)));const line=d3.line().x(d=>x(new Date(d.t))).curve(d3.curveMonotoneX);svg.append('path').datum(arr).attr('d',line.y(d=>yl(d.ir))).attr('fill','none').attr('stroke','#1a7f37').attr('stroke-width',1.8);svg.append('path').datum(arr).attr('d',line.y(d=>yl(d.dr))).attr('fill','none').attr('stroke','#cf222e').attr('stroke-width',1.8);svg.append('text').attr('x',p.l).attr('y',10).attr('font-size',9).attr('fill','#656d76').text('commits/hour');svg.append('text').attr('x',p.l).attr('y',71).attr('font-size',9).attr('fill','#656d76').text('lines/hour');svg.append('text').attr('x',w-p.r).attr('y',71).attr('font-size',9).attr('text-anchor','end').attr('fill','#1a7f37').text('+ inserted');svg.append('text').attr('x',w-p.r).attr('y',82).attr('font-size',9).attr('text-anchor','end').attr('fill','#cf222e').text('− deleted')}
function median(xs){const a=[...xs].sort((a,b)=>a-b),n=a.length;if(!n)return null;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2}
function theilSen(points){if(points.length<3)return null;const slopes=[];for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){const dx=points[j].x-points[i].x;if(dx>0)slopes.push((points[j].y-points[i].y)/dx)}const slope=median(slopes);if(slope===null)return null;const intercept=median(points.map(p=>p.y-slope*p.x));const mad=median(slopes.map(s=>Math.abs(s-slope)))||0;return{slope,intercept,mad}}
function remainingChart(el,history){el.innerHTML='';if(!history||history.length<2)return;const sec=windowSeconds();const cut=sec===null?-Infinity:Date.now()-sec*1000;const pts=history.filter(p=>new Date(p.time).getTime()>=cut).map(p=>({x:new Date(p.time).getTime()/3600000,y:p.remaining,time:p.time}));if(pts.length<2)return;const w=720,h=96,p={l:42,r:10,t:8,b:18};const x=d3.scaleLinear().domain(d3.extent(pts,d=>d.x)).range([p.l,w-p.r]);const y=d3.scaleLinear().domain(d3.extent(pts,d=>d.y)).nice().range([h-p.b,p.t]);const svg=d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`);svg.append('path').datum(pts).attr('d',d3.line().x(d=>x(d.x)).y(d=>y(d.y)).curve(d3.curveMonotoneX)).attr('fill','none').attr('stroke','#0969da').attr('stroke-width',1.8);svg.selectAll('circle').data(pts).join('circle').attr('cx',d=>x(d.x)).attr('cy',d=>y(d.y)).attr('r',2).attr('fill','#0969da');const fit=theilSen(pts);let label='';if(fit){const perHour=fit.slope;if(perHour<-.05){const eta=pts[pts.length-1].y/(-perHour);label=`Robust net burn ${(-perHour).toFixed(1)} cards/h · projected zero in ${eta.toFixed(0)}h if this net rate persists`; }else label=`Robust net trend ${perHour.toFixed(1)} cards/h; no completion projection at a non-decreasing rate`;svg.append('path').datum(pts).attr('d',d3.line().x(d=>x(d.x)).y(d=>y(fit.intercept+fit.slope*d.x))).attr('fill','none').attr('stroke','#57606a').attr('stroke-dasharray','4 3') } d3.select(el).append('div').attr('class','meta').text(label+' · Theil–Sen fit; source intake can add cards.')}
function graph(el,allNodes){el.innerHTML='';const nodes=allNodes.filter(n=>!n.closed);if(!nodes.length){el.innerHTML='<div class="meta">No open dependency work.</div>';return}const ids=new Set(nodes.map(d=>d.id));const links=[];nodes.forEach(n=>n.needs.forEach(a=>{if(ids.has(a))links.push({source:a,target:n.id})}));const w=800,h=205;const svg=d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`);const g=svg.append('g');svg.call(d3.zoom().scaleExtent([.35,6]).on('zoom',e=>g.attr('transform',e.transform)));const layer=new Map(nodes.map(n=>[n.id,0]));for(let z=0;z<nodes.length;z++){let changed=false;for(const l of links){const v=Math.max(layer.get(l.target),layer.get(l.source)+1);if(v!==layer.get(l.target)){layer.set(l.target,v);changed=true}}if(!changed)break}const groups=d3.group(nodes,n=>layer.get(n.id));for(const[k,ns]of groups){ns.forEach((n,i)=>{n.x=28+k*170;n.y=18+i*Math.max(24,180/Math.max(1,ns.length))})}const by=new Map(nodes.map(n=>[n.id,n]));g.selectAll('line').data(links).join('line').attr('x1',d=>by.get(d.source).x).attr('y1',d=>by.get(d.source).y).attr('x2',d=>by.get(d.target).x).attr('y2',d=>by.get(d.target).y).attr('stroke','#d0d7de');const ng=g.selectAll('g.n').data(nodes).join('g').attr('class','n').attr('transform',d=>`translate(${d.x},${d.y})`).on('pointermove',(e,d)=>showTip(e,`<b>${d.ready?'Available now':'Waiting on prerequisites'}</b><br>${esc(d.public)}`)).on('pointerleave',hideTip).on('click',(e,d)=>showTip(e,`<b>${d.ready?'Available now':'Waiting on prerequisites'}</b><br>${esc(d.public)}`));ng.append('circle').attr('r',d=>d.ready?7:5).attr('fill',d=>d.ready?'#1a7f37':'#bf8700');ng.append('text').attr('x',9).attr('y',3).attr('font-size',9).text(d=>d.public.length>44?d.public.slice(0,43)+'…':d.public)}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tip=d3.select('#tip');function showTip(e,s){tip.html(s).style('opacity',1);const node=tip.node(),gap=10;let left=e.clientX+12,top=e.clientY+12;const r=node.getBoundingClientRect();left=Math.min(left,innerWidth-r.width-gap);top=Math.min(top,innerHeight-r.height-gap);left=Math.max(gap,left);top=Math.max(gap,top);tip.style('left',left+'px').style('top',top+'px')}function hideTip(){tip.style('opacity',0)}
function updateRepo(r){const host=document.querySelector(`#repo-${CSS.escape(r.name)}`);const cs=selected(r.commits),hours=spanHours(r.commits);const ins=cs.reduce((a,c)=>a+c.insertions,0),del=cs.reduce((a,c)=>a+c.deletions,0);host.querySelector('.commit-rate').textContent=(cs.length/hours).toFixed(cs.length/hours<10?1:0);host.querySelector('.insert-rate').textContent='+'+(ins/hours).toFixed(ins/hours<100?1:0);host.querySelector('.delete-rate').textContent='−'+(del/hours).toFixed(del/hours<100?1:0);host.querySelector('.window-total').textContent=`${cs.length.toLocaleString()} commits · ${ins.toLocaleString()} inserted · ${del.toLocaleString()} deleted in ${active}`;rateChart(host.querySelector('.activity-chart'),r.commits);remainingChart(host.querySelector('.remaining-chart'),r.remaining_history)}
function updateAll(){document.querySelectorAll('.windows button').forEach(b=>b.classList.toggle('on',b.dataset.w===active));DATA.repos.forEach(updateRepo)}
document.querySelectorAll('.windows button').forEach(b=>b.addEventListener('click',()=>{active=b.dataset.w;updateAll()}));
for(const r of DATA.repos){const host=document.querySelector(`#repo-${CSS.escape(r.name)}`);graph(host.querySelector('.dagbox'),r.dag)}updateAll();
"""


def age_label(iso: str) -> str:
    delta = dt.datetime.now(dt.timezone.utc) - parse_iso(iso).astimezone(dt.timezone.utc)
    minutes = max(0, round(delta.total_seconds() / 60))
    exact = parse_iso(iso).strftime("%b %d %H:%M %z")
    if minutes < 60:
        relative = f"{minutes}m ago"
    elif minutes < 1440:
        relative = f"{round(minutes / 60)}h ago"
    else:
        relative = f"{round(minutes / 1440)}d ago"
    return f"{exact} · {relative}"


def render(data: dict[str, object], out: Path) -> None:
    cards: list[str] = []
    for repo in data["repos"]:
        assert isinstance(repo, dict)
        commits_html = "".join(
            f"<div class='row'><span class='when' title='{html.escape(str(commit['time']))}'>{age_label(str(commit['time']))}</span>"
            f"<span class='subject'><b>{html.escape(str(commit['subject']))}</b><div class='diff'>"
            f"<span>{int(commit['files']):,} files changed</span><span class='plus'>+{int(commit['insertions']):,}</span>"
            f"<span class='minus'>−{int(commit['deletions']):,}</span><span>{html.escape(str(commit['hash']))}</span></div></span></div>"
            for commit in repo["commits"][:14]
        )
        files_html = "".join(
            f"<div class='row'><span class='when' title='{html.escape(str(file['time']))}'>{age_label(str(file['time']))}</span>"
            f"<span class='subject'>{html.escape(str(file['path']))}</span></div>"
            for file in repo["files"][:14]
        )
        progress = repo["progress"]
        assert isinstance(progress, dict)
        cards.append(
            f"""
<section class="repo" id="repo-{html.escape(str(repo['name']))}">
  <header class="rh">
    <div><b>{html.escape(str(repo['name']))}</b> <span class="pill">{html.escape(str(repo['head']))}</span>
      <div class="objective">{html.escape(str(repo['objective']))}</div></div>
    <span class="state {html.escape(str(repo['classification']))}">{html.escape(str(repo['classification']))}</span>
  </header>
  <div class="activity">
    <div class="section-title">Banked change rate</div>
    <div class="rate-strip">
      <div class="rate"><b class="commit-rate">—</b><span>commits / hour</span></div>
      <div class="rate"><b class="insert-rate plus">—</b><span>inserted lines / hour</span></div>
      <div class="rate"><b class="delete-rate minus">—</b><span>deleted lines / hour</span></div>
    </div>
    <div class="meta window-total"></div>
    <div class="chart activity-chart"></div>
  </div>
  <div class="tails">
    <div class="tail-panel"><div class="section-title">Most recent commits</div><div class="tail">{commits_html}</div></div>
    <div class="tail-panel"><div class="section-title">Most recently written files</div><div class="tail">{files_html}</div></div>
  </div>
  <div class="progress">
    <div class="section-title">{html.escape(str(repo['progress_label']))}</div>
    <div class="progress-head">{html.escape(str(progress['headline']))}</div>
    <div class="progress-detail">{html.escape(str(progress['detail']))}</div>
    <div class="remaining-chart"></div>
  </div>
  <div class="dagwrap">
    <div class="dagtitle"><span class="section-title">Dependency map</span><span class="meta">drag / pinch / scroll · tap a node for its full plain-language description</span></div>
    <div class="dagbox"></div>
    <div class="meta">Gray = completed · green = available now · amber = waiting on prerequisites · {int(repo['dirty']['count']):,} current working-tree paths · {len(repo['processes']):,} repository-local processes</div>
  </div>
</section>
"""
        )
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    windows = json.dumps(WINDOWS, separators=(",", ":"))
    window_buttons = "".join(f"<button data-w='{label}'>{label}</button>" for label, _ in WINDOWS)
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5"><title>Workstream progress</title><style>{CSS}</style><script src="https://cdn.jsdelivr.net/npm/d3@7"></script></head><body><div class="wrap"><div class="top"><div><h1>Workstream progress</h1><div class="muted" style="font-size:11px">Recent banked work and live file activity first; dependency detail below. Rates are observability signals, not correctness certificates.</div></div><div class="muted" style="font-size:10px">refreshed {html.escape(str(data['generated_at']))}</div></div><div class="windows">{window_buttons}</div><div class="grid">{''.join(cards)}</div><div class="foot">Commit plots report commits/hour plus inserted/deleted lines/hour for the selected window. File-write timestamps are working-tree activity only. Remaining-work projections appear only where the repository exposes a meaningful numerical queue and use a robust Theil–Sen trend rather than a promise of delivery time.</div></div><div id="tip" class="tip"></div><script>window.__DATA__={payload};window.__WINDOWS__={windows};</script><script>{JS}</script></body></html>"""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(ROOT / "steward-dashboard/index.html"))
    parser.add_argument("--classification", action="append", default=[])
    args = parser.parse_args()
    classifications = {
        item.split("=", 1)[0]: item.split("=", 1)[1]
        for item in args.classification
        if "=" in item
    }
    data: dict[str, object] = {
        "generated_at": dt.datetime.now().astimezone().isoformat(),
        "repos": [],
    }
    repos = data["repos"]
    assert isinstance(repos, list)
    for name, repo in REPOS.items():
        repos.append(repo_payload(name, repo, classifications.get(name, "unknown")))
    render(data, Path(args.output))
    print(args.output)


if __name__ == "__main__":
    main()
