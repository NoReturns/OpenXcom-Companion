# ASTER-M1-S4J — Release candidate (push + gated build)

**Authorization:** Push + RC preparation only. **No** live `runtime/m0/bin` replacement, **no** GitHub tactical inbox commands, **no** SHA pin change in this pass.

## 1. Source commits (pushed)

| Repository | Branch | Local = remote HEAD | Notes |
|------------|--------|---------------------|--------|
| **OpenXcom** | `aster/m0` | `c5aa0293ebf8ea07f6edae2988837a6df56f6d2a` | WP9 `c5aa0293e` on top of WP10 `9302181c4`, `0562d5504` |
| **Companion** | `main` | `529a3d7dc11c9c181938f23ef94687cb68f8ddf0` | WP9 `529a3d7` on top of WP10 `105eabe`, `0df449d` |

**Push:** `origin/aster/m0` and `origin/main` fast-forward only (no force). Remote heads verified equal to local after push.

### Engine commit chain (recent)

```
c5aa0293e feat(m1-wp9): add medikit execution core and certification harnesses
0562d5504 fix(wp10): clear relay harness tile occupancy before unit teardown
9302181c4 feat(m1-wp10): PSI panic and mind-control command path through engine relay
```

### Companion commit chain (recent)

```
529a3d7 feat(m1-wp9): medikit relay bundle, runtime pin, and audit closeout
0df449d docs(wp10): S4C-S4E psi relay and predeploy audits
105eabe feat(m1-wp10): Node PSI panic and mind-control contracts with relay tests
```

## 2. Fresh Release build (CMake)

| Item | Value |
|------|--------|
| Configure | `cmake -S engine/OpenXcom -B build-s4j-rc -G "Visual Studio 17 2022" -A Win32` |
| Build tree | `engine/OpenXcom/build-s4j-rc/` (generated; **not** committed) |
| Build | `cmake --build build-s4j-rc --config Release` |
| Embedded git version | `1.0.c5aa0293e` (from committed engine HEAD) |

**Note:** Full solution build returned MSBuild exit **1** after primary targets linked (likely a non-gate target elsewhere in the solution). All **required gate binaries** were produced and passed.

## 3. Release candidate artifact (not deployed)

| Field | Value |
|-------|--------|
| **Path** | `engine/OpenXcom/build-s4j-rc/bin/Release/openxcom.exe` |
| **SHA-256** | `1f75c565e2f59f0909e4a79aa12ec54937a8585ff275fd59eb95aea4c322dad7` |
| **Size** | 4,394,496 bytes |

## 4. Live runtime (unchanged in S4J)

| Field | Value |
|-------|--------|
| **Path** | `runtime/m0/bin/openxcom.exe` |
| **SHA-256** | `1b08eb6854f400eb486d8b378292cd5d1c67c4281769ea310d1c3fdec60ebab2` |
| **Pin** | `companion-canonical-runtime.cjs` → `VERIFIED_BUILD_SHA256` matches live (**unchanged**) |

RC SHA **≠** live pin — expected until an explicit promote/deploy updates pin + manifest.

## 5. Focused gate results (`build-s4j-rc/bin/Release`)

| Gate | Exit |
|------|------|
| `companion_medikit_release_smoke_test.exe` | **0** |
| `companion_medikit_engine_test.exe` | **0** |
| `companion_psi_panic_engine_test.exe` | **0** |
| `companion_psi_mind_control_engine_test.exe` | **0** |
| `companion_command_test.exe` | **0** |
| `companion_snapshot_serialization_test.exe` | **0** |
| `companion_snapshot_export_test.exe` | **0** |
| Node WP9 S1 / S3 / S4 | **14/14 pass** |

## 6. Deployment requirements (before any promote)

1. **Do not** copy RC to `runtime/m0/bin` until owner authorizes and hash gate is updated.
2. **`companion-canonical-runtime.cjs` → `buildReleaseExe`** still prefers `engine/OpenXcom/build-isolated-m1-23e/bin/Release/openxcom.exe`. **Verify or retarget** before `deploy-openxcom.ps1` so deploy does not pick a stale build directory.
3. On promote: set `VERIFIED_BUILD_SHA256` to RC hash, rebuild Companion verify tests, run deploy script, confirm manifest + live runtime match.
4. **WP10 live drill:** panic/mind-control remains human-authorized; engine gates green only certify binary readiness.
5. **WP9 medikit scope:** co-tile and relay rejection paths certified; **adjacent facing-correct HEAL on real mission terrain remains uncertified.** Existing live medikit success does not extend to every adjacent targeting scenario.

## 7. Certification limits (explicit)

- Release smoke: production ruleset relay (co-tile HEAL + adjacent mis-aim reject), not homogenous DESERT adjacent success.
- S4H RCA documents fixture vs production distinction.

**STOP** — S4J complete. RC recorded; live executable preserved.