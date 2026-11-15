# ASTER-M1-S4K — Release candidate clearance (solution build classification)

**Authorization:** Investigation + documentation only. **No** executable replacement, **no** live inbox, **no** unrelated CMake fixes.

## Clearance verdict

| Criterion | Status |
|-----------|--------|
| Full solution `cmake --build build-s4j-rc --config Release` exit **1** | **Classified** — single failing target, not RC-blocking |
| `openxcom.exe` | **Built successfully** — not affected by failure |
| Required native + Node gates | **Green** (see §4) |
| RC SHA-256 preserved | **Verified** `1f75c565…` |
| Live runtime | **Unchanged** `1b08eb685…` |
| CMake source of truth | **Yes** — `build-s4j-rc` generated from committed `c5aa0293e`; no hand-edited `.vcxproj` |

**RC remains accepted for promote planning; deployment still blocked until owner authorize + pin/manifest update.**

## 1. Failing project (exact)

**Project:** `companion_manual_upload_hud_test`  
**Path:** `engine/OpenXcom/build-s4j-rc/src/companion_manual_upload_hud_test.vcxproj`

**Errors (repro build log:** `local/m0/build-s4j-rc-full-build.log`**):**

```
CompanionOnDemandRelayCore.obj : error LNK2019: unresolved external symbol
  OpenXcom::CompanionAutoRetrieveCore::isBattlescapeActive()

CompanionOnDemandRelayCore.obj : error LNK2019: unresolved external symbol
  OpenXcom::CompanionStrategicSendEnqueueSupport::buildStrategicMarkerPrepFromLiveExport(...)

fatal error LNK1120: 2 unresolved externals
```

**Cause class:** The HUD unit-test executable links a **subset** of engine objects (`CompanionOnDemandRelayCore.cpp` plus manual-export peers) but **omits** translation units that define the two symbols above. `openxcom` links the full `openxcom_src` graph and resolves those symbols.

**Relation to WP9/WP10:** None. Medikit and psi paths are not in this link line.

**Not repaired in S4K:** Per authorization — optional harness link list only; fixing it is a separate hygiene task, not required for RC integrity.

## 2. `openxcom.exe` and required targets

Same log shows **successful** outputs immediately before/after the failed target in parallel MSBuild:

- `openxcom.vcxproj -> …\build-s4j-rc\bin\Release\openxcom.exe` (**success**)
- All S4J gate executables (medikit, psi panic/MC, command, snapshot, release smoke) **built successfully**

**Conclusion:** Solution exit **1** is **not** evidence of a defective RC binary; it is an **optional companion HUD test** link defect.

**Contrast:** `companion_on_demand_relay_test` (full on-demand relay harness) **links cleanly** in the same solution build — production relay path is not implicated.

## 3. RC artifact

| Field | Value |
|-------|--------|
| Path | `engine/OpenXcom/build-s4j-rc/bin/Release/openxcom.exe` |
| SHA-256 | `1f75c565e2f59f0909e4a79aa12ec54937a8585ff275fd59eb95aea4c322dad7` |
| Engine commit | `c5aa0293ebf8ea07f6edae2988837a6df56f6d2a` |
| CMake configure | Fresh `build-s4j-rc` from `aster/m0` HEAD |

## 4. Regression gates (S4K run)

### Native (`build-s4j-rc/bin/Release`)

Prior S4J runs: all required harnesses **exit 0** (unchanged binaries; not re-run in S4K unless needed — RC hash match confirms artifact preservation).

### Node — WP9 (S4J reference)

`tactical-command-m1-wp9-medikit-s{1,3,4}-*.test.cjs` — **14/14 pass**.

### Node — WP10 (S4K)

```
tactical-command-m1-wp10-psi-panic-s1.test.cjs
tactical-command-m1-wp10-psi-panic-s3-relay.test.cjs
tactical-command-m1-wp10-psi-mind-control-s1.test.cjs
tactical-command-m1-wp10-psi-mc-s3-relay.test.cjs
```

**Result:** **21/21 pass** (`duration_ms` ~224).

## 5. Deployment decision matrix (updated)

| Gate | Ready |
|------|--------|
| GitHub backup (engine + companion) | **Yes** |
| WP9/WP10 native Release gates | **Yes** |
| Full solution exit 0 | **No** — **classified non-blocking** |
| WP10 Node 21/21 | **Yes** |
| Live deploy | **Not authorized** — pin still `1b08eb685…`; update `buildReleaseExe` path before promote |

## 6. Promote checklist (owner, post-S4K)

1. Promote `build-s4j-rc/bin/Release/openxcom.exe` (or reproducible rebuild with same commit).
2. Update `VERIFIED_BUILD_SHA256` + manifest to `1f75c565…`.
3. Retarget or verify `companion-canonical-runtime.cjs` `buildReleaseExe` (currently `build-isolated-m1-23e`, not `build-s4j-rc`).
4. Run live psychic drill per WP10 plan.
5. Adjacent mission-terrain medikit HEAL remains **uncertified**.

**STOP** — S4K complete.