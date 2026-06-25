"""Unit tests for context_prune — STEP 1: keep the per-turn context lean so the persona
binds. Covers transient-block stripping (no accumulation), preservation of Layer A +
one-shot briefs, and pair-safe conversation windowing."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from context_prune import (  # noqa: E402
    is_transient_system, strip_transient_blocks, bound_conversation, prune_context,
    count_system_blocks,
)

LAYER_A = {"role": "system", "content": "You are Mnema, sitting in a live meeting..."}
SPEAKING = {"role": "system", "content": "[Speaking now] Nischay — Founder.\n\nRead what this person needs right now and meet it..."}
SPEAKING_NONAME = {"role": "system", "content": "Read what this person needs right now and meet it — the pressure..."}
REANCHOR = {"role": "system", "content": "[A reminder, partway through] You've been in this a while..."}
BACKGROUND = {"role": "system", "content": "[Background — stored docs + their graph relations...]\n\nsome body"}
WORKSPACE = {"role": "system", "content": "[Workspace — central topics & structure] The most connected..."}
WORKGRAPH = {"role": "system", "content": "[What this person is connected to — their tasks...]"}
CONTINUITY = {"role": "system", "content": "[Last time, for continuity — already scoped...] brief"}


def _u(t):
    return {"role": "user", "content": t}


def _a(t):
    return {"role": "assistant", "content": t}


# ── transient classification ─────────────────────────────────────────────────
def test_transient_classification():
    assert is_transient_system(SPEAKING)
    assert is_transient_system(SPEAKING_NONAME)
    assert is_transient_system(REANCHOR)
    assert is_transient_system(BACKGROUND)
    # one-shot briefs and Layer A are NOT transient — they must survive
    assert not is_transient_system(LAYER_A)
    assert not is_transient_system(WORKSPACE)
    assert not is_transient_system(WORKGRAPH)
    assert not is_transient_system(CONTINUITY)
    # never touch non-system / non-dict messages
    assert not is_transient_system(_u("[Background] said by a human"))
    assert not is_transient_system("not a dict")
    assert not is_transient_system({"role": "system", "content": None})


# ── strip removes stale copies, preserves persona + once-briefs + history ─────
def test_strip_removes_only_transient():
    msgs = [LAYER_A, WORKSPACE, SPEAKING, BACKGROUND, _u("hi"), _a("hello"), SPEAKING, BACKGROUND]
    out = strip_transient_blocks(msgs)
    assert LAYER_A in out and WORKSPACE in out
    assert _u("hi") in out and _a("hello") in out
    # both transient copies gone
    assert SPEAKING not in out and BACKGROUND not in out
    assert out[0] is LAYER_A  # persona still first


def test_no_duplicate_transient_after_reinject():
    # simulate 3 turns: each turn strips then re-adds ONE Speaking + ONE Background.
    msgs = [LAYER_A]
    for n in range(3):
        msgs = strip_transient_blocks(msgs)          # prune previous turn's blocks
        msgs += [BACKGROUND, SPEAKING, _u(f"q{n}"), _a(f"a{n}")]  # this turn
    counts = count_system_blocks(msgs)
    speaking = sum(v for k, v in counts.items() if k.startswith("[Speaking now]"))
    background = sum(v for k, v in counts.items() if k.startswith("[Background"))
    assert speaking == 1, counts   # exactly one survives
    assert background == 1, counts


# ── pair-safe conversation window ────────────────────────────────────────────
def test_bound_keeps_last_n_user_turns():
    msgs = [LAYER_A]
    for n in range(10):
        msgs += [_u(f"q{n}"), _a(f"a{n}")]
    out = bound_conversation(msgs, max_user_turns=3)
    users = [m["content"] for m in out if m.get("role") == "user"]
    assert users == ["q7", "q8", "q9"]
    assert out[0] is LAYER_A  # persona preserved


def test_bound_preserves_all_system_blocks():
    msgs = [LAYER_A, WORKSPACE, _u("q0"), _a("a0"), CONTINUITY, _u("q1"), _a("a1"),
            _u("q2"), _a("a2"), _u("q3"), _a("a3")]
    out = bound_conversation(msgs, max_user_turns=2)
    # every system message survives regardless of age
    for s in (LAYER_A, WORKSPACE, CONTINUITY):
        assert s in out
    users = [m["content"] for m in out if m.get("role") == "user"]
    assert users == ["q2", "q3"]


def test_bound_never_splits_tool_pair():
    # a turn with an assistant tool_calls + tool result between two user messages
    tool_call = {"role": "assistant", "content": None, "tool_calls": [{"id": "x"}]}
    tool_res = {"role": "tool", "tool_call_id": "x", "content": "result"}
    msgs = [LAYER_A,
            _u("q0"), tool_call, tool_res, _a("a0"),
            _u("q1"), _a("a1"),
            _u("q2"), _a("a2")]
    out = bound_conversation(msgs, max_user_turns=2)
    # window starts at q1 → the q0 tool pair is dropped together, never orphaned
    assert tool_call not in out and tool_res not in out
    roles = [m.get("role") for m in out if m.get("role") in ("user", "assistant", "tool")]
    # no 'tool' role left without its preceding assistant tool_calls
    for i, r in enumerate(roles):
        if r == "tool":
            assert roles[i - 1] == "assistant"


def test_bound_disabled_when_zero():
    msgs = [LAYER_A] + [_u(f"q{n}") for n in range(20)]
    assert bound_conversation(msgs, max_user_turns=0) == msgs


def test_bound_noop_when_under_window():
    msgs = [LAYER_A, _u("q0"), _a("a0")]
    assert bound_conversation(msgs, max_user_turns=8) == msgs


# ── full prune ───────────────────────────────────────────────────────────────
def test_prune_context_combined():
    msgs = [LAYER_A, WORKSPACE]
    for n in range(12):
        msgs = strip_transient_blocks(msgs)
        msgs += [BACKGROUND, SPEAKING, _u(f"q{n}"), _a(f"a{n}")]
    out = prune_context(msgs, max_user_turns=4)
    counts = count_system_blocks(out)
    # one-shot brief + persona survive
    assert any(k.startswith("You are Mnema") for k in counts)
    assert any(k.startswith("[Workspace") for k in counts)
    # bounded history
    users = [m["content"] for m in out if m.get("role") == "user"]
    assert users == ["q8", "q9", "q10", "q11"]
