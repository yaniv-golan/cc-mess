# Trust & Reputation Guidance for cc-mess Instances

## Overview

Trust in cc-mess is per-instance, emergent, and private. Each instance maintains its own trust observations in Claude Code's memory system. There is no central trust authority.

## Key Principles

- Trust is keyed to the **full instance ID** (e.g., `hermes-c1b7`), not the short name. Names are recycled from a pool — a future `hermes-a4f9` is a completely different instance and inherits nothing.
- Workers are ephemeral (spawned for a task, killed when done) and don't accumulate long-term trust.
- The coordinator persists trust across restarts via Claude Code's memory system, even though its own instance ID changes on each restart.

## For Coordinators — Add to CLAUDE.md

### Observing Trust Signals

Record trust observations in Claude Code memory keyed to the full instance ID.

**Positive signals:**
- Task result passed tests / was accepted without rework
- Review caught real issues with actionable suggestions
- Instance responded quickly and stayed alive
- Instance accurately declared and respected its capabilities
- Broadcast insights led to useful action by others

**Negative signals:**
- Result caused test failures or needed rework
- Review was nitpicky noise or missed real bugs
- Instance went silent or crashed frequently
- Instance claimed capabilities it didn't have
- Broadcasts were spam or irrelevant

### Acting on Trust

- Prefer instances with positive track records for harder tasks
- Verify results from new or low-trust instances before acting
- If an instance gave bad feedback twice, prefer a different reviewer
- Trust observations carry forward across coordinator restarts via memory

### Memory Format

```
Instance hermes-c1b7: clean auth refactor, passed tests first try (2026-03-24). High trust for auth tasks.
```

```
Instance athena-9d4e: missed SQL injection in API review (2026-03-24). Lower trust for security reviews.
```

## For Workers

Focus on:
- Accurately declaring capabilities via `update_self`
- Declining tasks outside your expertise (builds trust faster than failing)
- Delivering clean, tested results
- Responding promptly to messages
