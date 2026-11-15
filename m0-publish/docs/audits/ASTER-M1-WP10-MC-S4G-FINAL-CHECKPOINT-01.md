# ASTER-M1-WP10-MC-S4G — final WP9 integration checkpoint

**Authorization:** Final gates + **conditional** local commits.
**Outcome:** **STOP — release smoke gate failed; no commits performed.**

---

## Gate matrix

| # | Gate | Result | Notes |
|---|------|--------|-------|
| 1 | Node WP9 S4 relay E2E | **PASS** | `tactical-command-m1-wp9-medikit-s4-relay-e2e.test.cjs` — **3/3** (Node compose/dry-run + engine harness via `companion_medikit_engine_test`) |
| 2 | Release smoke (`companion_medikit_release_smoke_test.exe`) | **FAIL** | **exit 1**, 4 failures (see §2) |
| 3 | WP10 panic / MC unaffected | **PASS** | S4F `build-s4f-integrated\bin\Release`: `companion_psi_panic_engine_test.exe` **0**, `companion_psi_mind_control_engine_test.exe` **0** |
| 4 | WP9 file inventory review | **Complete** | §3 |
| 5 | CMake in **tracked** `src/CMakeLists.txt` | **Present** (uncommitted) | `CompanionMedikitExecutionCore.cpp` in `openxcom_src` — not only generated vcxproj |
| 6 | `git diff --check` | **PASS** | No whitespace errors on engine/companion working diffs |

**Conditional commit rule:** Smoke failure blocks local WP9 bundle commits per owner mandate.

---

## 2. Release smoke failure detail

**Binary:** `engine/OpenXcom/build-s4f-integrated/bin/Release/companion_medikit_release_smoke_test.exe`
**CWD:** exe directory (loads rules from `runtime/m0/bin` when probes succeed — rulesets logged loaded).

| Assertion | Outcome |
|-----------|---------|
| `DESERT MCD floor supports adjacent native medikit target` | **FAIL** — no walkable DESERT floor object in scan produced `resolveNativeMedikitTarget` → patient id 2 |
| `release smoke adjacent east COMPLETED` | (downstream of floor scan; some relay `COMPLETED` logs observed for other smoke ids) |
| `mis-aim not COMPLETED` | **FAIL** — terminal status **COMPLETED** when facing mis-aim case expected reject |
| `mis-aim leaves charges` / `mis-aim leaves TU` | **FAIL** — consistent with mistaken COMPLETED on mis-aim path |

**Classification:** Aligns with prior [ASTER-M1-WP9-MEDIKIT-RELEASE-SMOKE-01.md](./ASTER-M1-WP9-MEDIKIT-RELEASE-SMOKE-01.md) — **adjacent production-ruleset HEAL** not certified; smoke is **manual / optional**, not default WP9 gate. S4G still treats owner-requested smoke as a **blocking** gate → **no commit**.

**Not run:** Live `runtime/m0/bin/openxcom.exe` unchanged.

---

## 3. WP9 inventory (intended commit bundle when unblocked)

### Engine — base `0562d5504`

| Path | Include when unblocked |
|------|------------------------|
| `src/CMakeLists.txt` | Yes — medikit execution core in `openxcom_src` |
| `src/Engine/CompanionMedikitExecutionCore.{cpp,h}` | Yes |
| `src/test/companion_medikit_engine_test.cpp` | Yes |
| `src/test/companion_medikit_relay_e2e_harness.cpp` | Yes |
| `src/test/companion_medikit_release_smoke_test.cpp` | Yes (manual smoke; documents known adjacent limitation) |
| `src/Battlescape/ActionMenuState.cpp` | Yes — delegate to `resolveNativeMedikitTarget` |
| `src/Battlescape/TileEngine.cpp` | Yes — empty `_trajectory` guard in `canTargetUnit` |

**Exclude:** `build-*`, relay scratch, temp trees.

### Companion — base `0df449d`

| Path | Include when unblocked |
|------|------------------------|
| `m0-publish/lib/companion-canonical-runtime.cjs` | Yes |
| `m0-publish/lib/tactical-equipment-brief.cjs` | Yes |
| `m0-publish/docs/M1-wp2-unit-state-schema.md` | Yes |
| `m0-publish/test/tactical-command-m1-wp9-medikit-*.test.cjs` | Yes |
| `m0-publish/test/medikit-s0-observation.test.cjs` | Yes |
| `m0-publish/test/helpers/medikit-wp9-fixture.cjs` | Yes |
| `m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-*.md` | Yes |
| `m0-publish/docs/audits/ASTER-M1-WP10-MC-S4F-*.md` | Yes (S4F report; add at commit time) |
| This S4G report | Yes |

**Exclude:** `err.txt`, `out.txt`, `.staging-base`, `.wip-full`, `companion_bi1_test_*`, equipment audit unless owner expands scope.

### Coexistence (S4G spot-check)

WP9 medikit relay uses `MEDIKIT_*` types; WP10 uses `PSI_PANIC` / `PSI_MIND_CONTROL`. Integrated S4F link + S4G psi re-run show **no regression** on panic/MC harness after medikit integration in same binary.

---

## 4. S4F integrated artifact (unchanged)

| Property | Value |
|----------|--------|
| Path | `build-s4f-integrated/bin/Release/openxcom.exe` |
| SHA-256 | `E1206276FDDA9CDDFB3E1D8759E27006D79B2A6DC7B2FCE3DABA98BD88C996E8` |

Live runtime SHA unchanged: `1B08EB6854F400EB486D8B378292CD5D1C67C4281769EA310D1C3FDEC60EBAB2`.

---

## 5. Commits

**None created** (smoke gate failure).

Prior checkpoints unchanged:

| Repo | Last commit |
|------|-------------|
| `engine/OpenXcom` | `0562d5504` (S4D harness only) |
| `companion` | `0df449d` (S4C–S4E docs) |

---

## 6. Recommended unblock paths (owner decision — not implemented)

1. **Treat release smoke as non-blocking** for WP9 **relay-certified** scope (co-tile / engine E2E green) and commit bundle without adjacent desert certification; keep smoke manual + documented HOLD.
2. **Or** fix smoke harness / native adjacent LOS on disposable DESERT grid until exit 0, then re-run S4G and commit.

---

## STOP — S4G complete

No push, deploy, or live relay. Await owner direction on smoke gate disposition before WP9 local commits.