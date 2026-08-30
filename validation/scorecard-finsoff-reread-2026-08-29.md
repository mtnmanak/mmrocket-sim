# Scorecard note — ARCAS-Long fins-off third read — 2026-08-29

**Change: none.** No anchor value, tolerance, fixture or kernel byte moved. This note records a
measurement that CONFIRMS the standing `arcas-long-finsoff` anchors and retires a hypothesis.

**The hypothesis under test** (open-items register, 2026-08-27/29): that a single **+0.020**
read error in the digitised TN D-4013 Figure 12 fins-off curve would reconcile both halves of
the ARCAS-Long anomaly at once (body drag +17.9 % → +9.2 %, matching Short's +8.3 %; fin
increment −38 % → −22 %). "Cheap, no code."

**The test.** The NTRS report scan and the 2026-08-25 digitisation pipeline live on the other
machine, so this read used the local Figure-12 reproduction
(`docs/User files/TRF RASAero Files/1778710171376.png` — the same image the 2026-08-25 pass
cross-checked against the report scan to rms 0.0010–0.0011) with an independent method and
independent code: PNG decoded from bytes, both axes calibrated by least-squares against the
detected gridlines (C_A zero line and the 0.80 line land dead-on; the 0.25 gridline is
confirmed drawn only at M ≥ 1.1, exactly as the 2026-08-25 scorecard noted), and the fins-off
dash-dot trace read by sub-pixel luminance centroid over a ±7-px window per Mach station.

**Result — the third read agrees with the gated anchors, not with the hypothesis:**

| M | this read | 2026-08-25 anchor | delta | a +0.020 error would read |
|---|---|---|---|---|
| 0.62 | 0.2499 | — | — | ~0.270 |
| 0.65 | 0.2499 | — | — | ~0.270 |
| 0.70 | 0.2490 | 0.2489 (fairing series) | **+0.0001** | 0.269 |
| 0.75 | 0.2490 | — | — | ~0.270 |
| 0.80 | 0.2522 | 0.2495 (fairing series) | **+0.0027** | 0.270 |
| 0.85 | 0.2579 | — (rise begins) | — | — |

Scale sanity: the fins-ON pair at M0.70 reads C_A **0.3596** by the same method — where the
report and RASAero place it.

**Ruling.** The fins-off anchor is now confirmed by three independent reads (the 2026-08-03
deck read, the 2026-08-25 report-scan digitisation, this one) agreeing within a few thousandths
— an order of magnitude below the hypothesized +0.020. **The register's re-read item is closed:
the anomaly is not a data-read error.** The body-drag split (Long +17.9 % vs Short +8.3 %) and
the fin-increment reading stand as genuine model/geometry questions, and whoever attacks them
next should not spend time re-reading this figure again.

**Precision caveat, stated honestly:** this method's absolute precision is a few thousandths of
C_A (limited by the 622.5 px-per-unit reproduction and the dash-dot trace), which is ample to
kill a 0.020 hypothesis but is NOT a replacement digitisation — the gated values remain the
2026-08-25 report-scan read at ±0.008.
