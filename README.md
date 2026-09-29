# crossmgr-triangulate

A side project for [crossmgr-antenna](https://github.com/erSitzt/crossmgr-antenna). It uses real reads from tags at surveyed positions to

1. **auto-place the antennas**: estimate each antenna's position, yaw/pitch and gain offset, and write them back into a crossmgr-antenna setup.
2. **validate the read zone**: compare measured RSSI and read/no-read per tag and port against the RF model, and find the ground material that fits best.

It reuses crossmgr-antenna's RF model directly (git submodule in `vendor/crossmgr-antenna`, imported as `@antenna/*`): the antenna pattern, tag dipole, ground reflection, obstacles and the `Setup` format. The solver inverts `evalLink()`. Nothing is duplicated.

## How it works (and what to expect)

This is **not** trilateration from "RSSI → distance". That is useless at ±3–6 dB multipath scatter. Instead the solver searches, for each antenna, for the pose at which the full link model reproduces the median RSSI of every reference tag. It also has to respect which tags were *not* read on that port:

- A robust (Huber) Levenberg–Marquardt fit, with priors that keep the result near the planned pose.
- Every reference tag × port gives either an RSSI residual or a "must be out of range" constraint.
- Each observation depends on one antenna only, so every antenna is solved on its own with 24 starts. That reliably finds the global minimum.
- 1σ uncertainties come from the Jacobian and are flagged when weak. For a panel pointing straight down, yaw is barely observable.

Synthetic recovery uses the default arch (2 antennas on the left upright, 1 on the crossbar), a plan that is up to 1 m / 15° / 1.5 dB wrong, and 3 dB RSSI scatter:

| Survey | along member (median / p90) | yaw | pitch | gain offset |
|---|---|---|---|---|
| 12 stakes | 0.16 / 0.41 m | 2.4 / 5.3° | 4.3 / 11° | 0.6 / 0.9 dB |
| 18 stakes (default: 3 × 3, 2 heights) | 0.06 / 0.23 m | 1.3 / 4.3° | 3.1 / 9.5° | 0.5 / 0.8 dB |
| 36 stakes (4 × 3, 3 heights) | 0.03 / 0.08 m | 0.8 / 2.2° | 2.0 / 4.5° | 0.2 / 0.6 dB |

95–100% of the true values fall within the reported ±3σ. These numbers assume the model is right apart from random scatter. In the field, systematic model error (tag detuning, ground, nearby metal) adds to them, and the Validate tab is where you see it.

### Phase walks: cm-level positions

The R420 reports the RF phase of every read, and the round-trip phase is 4π·d/λ plus an unknown offset. Carry one tag along a straight, chalked line at walking pace, and each antenna records how its range to the tag changes, to a few mm. The phase fit (Phase tab) takes these range curves and solves for:

- each antenna's **phase-centre position** (x/y/z),
- the walking-speed profile, shared by all antennas (knots every 1 s, kept smooth),
- one unknown offset per gap-free series of reads (solved in closed form),
- the reader's phase sign convention.

It works on 2θ, which removes the π jumps in the Impinj phase report.

Phase only gives positions. The antennas' aim still comes from the RSSI grid: *Then fit yaw/pitch/gain from the RSSI capture* holds the phase positions fixed and fits only the angles and gain offset.

Synthetic results use 3 recommended walks, 0.1 rad phase noise, 5 mm multipath and a plan up to 1 m / 15° off, over 8 seeds:

| | position (median / p90) | pitch (median / p90) | yaw (median / p90) |
|---|---|---|---|
| RSSI grid only | 8.6 / 34 cm | 3.4 / 16° | 1.4 / 2.6° |
| Phase walks + RSSI grid | **1.3 / 3.0 cm** | 2.2 / 8.9° | 1.5 / 3.6° |

**Walk geometry matters.** Every point on a circle around a straight line has the same range curve, so one walk leaves each antenna's position ambiguous (mirror images). Walks all at about the same height leave height weakly determined. The *Recommended* button sets up:

1. along the centre line at 0.4 m,
2. across under the arch at 1.6 m,
3. low (0.3 m) along the track edge, 0.8 m in front of each upright that carries antennas.

The third walk is what pins down the height of antennas on the uprights. The fit warns when a coordinate stays weak.

**Protocol per walk:**

- Tag on a non-metallic pole, dipole vertical.
- Stand **3 s** on the start mark, walk **slowly (≤ 0.5 m/s)** to the end mark, stand **3 s**. The still phases anchor where the walk starts and ends.
- Use one **fixed channel**. With hopping, each channel only gets a quarter of the reads, and the phase can't be unwrapped.
- Keep everyone else out of the zone.

Recording and loading sessions work the same way as for the grid.

**Rehearsing with the mock reader.** When connected to the mock, each walk gets a *Mock walk* button. It plays the walk back through the bridge as live reads, using the same stand/walk/stand pattern with phase noise and the Impinj π jumps. The positions it uses are the green "true" antennas (Capture → Offline → *Simulate capture* sets them), so you can compare the fit against them. Walk reads don't replace the current RSSI capture. The speed-up (up to 8×) keeps the reads per metre the same, and the timestamps stay on the walk's own clock. The WebSocket command is `{"cmd": "mockWalk", "from": [...], "to": [...], "epc": "WALK0001", "speed": 0.35, "standS": 3, "timeScale": 1, "antennas": [{"port": 1, "position": [...]}]}`. The mock's RSSI is a plain distance model with no antenna pattern, so rehearse the angle refinement with a simulated capture, not with the mock's own static tags.

Out of scope: tracking moving riders. The R420 visits its ports one after another (about 25 ms each), so at race speed the three antennas never see the tag at the same position.

## Physical setup

- **Reader:** Impinj R420 (firmware 5.x), with the 3 antennas on ports 1–3 of the *same* reader (one clock, one LLRP session). Stop CrossMgrImpinj first, because the reader accepts only one LLRP client. The Zebra FX9500 is untested; its LLRP reports probably have no phase angle.
- **Cables:** measure the loss of each cable and enter it in crossmgr-antenna (`cableLossDb`). The fit then only estimates a small residual offset (prior ±2 dB) instead of trading gain against distance.
- **Frame:** the same as crossmgr-antenna. Metres, origin at the finish-line centre on the ground, +X is the direction of travel, +Z is the rider's right, Y is up.
- **Reference tags:** 12–20 inlays of the race tag model (e.g. Dogbone M730) on **plastic or wooden stakes**, never metal.
  - Place them at 2–3 heights (0.3–1.5 m), spread over the whole read zone including its edges, at least 0.5 m apart.
  - Use the same dipole orientation for all of them, and record it.
- **Survey:** measure every stake from two fixed marks (for example the truss feet) with a laser distance meter; ±2 cm is plenty. Enter the positions in the Survey tab or import a `survey.json`:
  ```json
  { "name": "Finish 2026-10", "tags": [ { "epc": "E28011…", "pos": [-2, 0.4, -3], "axis": [0, 1, 0] } ] }
  ```
- **Capture:** a fixed Tx power (taken from the setup), Dual Target search mode with session 0 (static tags keep reporting), one fixed channel, and 10–30 s per layout. Keep people out of the zone while capturing.
- **More stakes than tags:** move the stakes and capture again; each placement is its own survey and capture. Combining several placements in one fit is on the roadmap.

## Running it

```bash
git clone --recursive https://github.com/erSitzt/crossmgr-triangulate   # or: git submodule update --init
```

The bridge (Python 3.10+):

```bash
cd server && python -m venv ../.venv && ../.venv/Scripts/pip install -r requirements.txt && ../.venv/Scripts/python app.py
```

It listens on http://127.0.0.1:18788 and serves `web/dist` once that is built.

The web app:

```bash
cd web && npm install && npm run dev
```

It runs on http://localhost:5174 and proxies `/ws` and `/api` to the bridge.

To check a reader once (this shows whether phase, Doppler and high-resolution RSSI are reported):

```bash
.venv/Scripts/python server/probe.py 192.168.1.50 --count 50
```

### Workflow

1. **Setup:** import the crossmgr-antenna setup JSON (Setup → Export there).
2. **Survey:** enter the reference tags. EPCs the reader has seen are offered in the EPC field.
3. **Capture:** connect (or tick *Mock reader*), then Start and Record. Sessions are saved as JSONL in `sessions/` and can be loaded again with *Load session…*. *Simulate capture* rehearses the whole flow using the RF model, with random mounting errors whose truth is shown in green.
4. **Solve:** choose per antenna *on truss* (along the member + yaw/pitch; fewest unknowns), *free* or *fixed*, then *Fit antennas*.
5. **Phase** (optional, recommended): *Recommended* walks, then for each walk *From live reads* / *Load session…* / *Simulate* (or *Mock walk* when connected to the mock reader), then *Fit positions*. The result becomes the current fit.
6. **Validate:** look at Δ = measured − model per port and per tag, the missed/unexpected reads, and the ground scan.
7. **Export setup** (Solve tab) and import that into crossmgr-antenna. Its pass simulation and virtual wall then use the measured antenna poses.

## Layout

```
server/                 FastAPI + sllurp bridge
  llrp_client.py        Impinj extensions: phase, Doppler, high-res RSSI, channel; mock reader with walk playback
  recorder.py           JSONL sessions (header + one read per line)
  probe.py              reader check from the command line
web/src/
  survey/               reference tags, grid generator, survey.json
  capture/              live WebSocket client, aggregation (median RSSI, rate, circular-mean phase per channel)
  solve/                parameters (free / truss mount / angles), LM solver, RSSI fit, synthetic truth, web worker
  phase/                walks: still-phase detection, 2θ unwrapping, phase fit (analytic Jacobian), RSSI combination, synthetic walks
  validate/             residual summaries, ground scan
  ui/                   panels + 3D view (reuses crossmgr-antenna's TrackMesh / TrussMesh)
vendor/crossmgr-antenna git submodule
```

Tests: `cd web && npm test` (RSSI and phase recovery, walk preparation, parameters, statistics, validation) and `cd server && ../.venv/Scripts/python -m pytest` (report parsing, sllurp config and ROSpec encoding).

## Notes on LLRP / sllurp

- sllurp 3.x decodes the Impinj fields as `ImpinjPeakRSSI` (1/100 dBm), `ImpinjRFPhaseAngle` (0–4095 → 0–2π) and `ImpinjRFDopplerFrequency` (1/16 Hz).
- sllurp reads the channel list as `Channelist` in one place and `ChannelList` in another, so the bridge passes both.
  - One channel is set through `RFTransmitter.ChannelIndex` (a fixed frequency).
  - Several channels become an `ImpinjFixedFrequencyList`.
- The Impinj phase may jump by π between inventory rounds. The aggregation averages 2θ and halves the result.

## Roadmap

- Phase with channel hopping: a per-channel offset is already modelled, but the unwrapping needs denser reads per channel.
- **Multi-placement fit:** several survey + capture pairs in one solve, so a few tags can cover many spots.
- Fitting global model parameters (tag backscatter, reader sensitivity) jointly, not just scanning them.
