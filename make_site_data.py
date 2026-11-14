"""Build the data files of the AireMañana website (web/).

    python make_site_data.py evaluate   # once: test-period results -> web/data/evaluation.json + data/residuals.json
    python make_site_data.py live       # every evening: tomorrow's forecast for all 24 stations -> web/data/forecast.json

The numbers in `evaluate` are the same as in the notebook AireManana.ipynb (same splits, model and thresholds).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from forecast_model import (_HOLIDAYS, LIMIT, AireManana, baseline_persistence, baseline_weekday_rule, build_table,
                            scores)
from live import forecast_tomorrow
from madrid_data import STATIONS, realtime_hourly, weather_live

WEB = Path("web/data")
STATION = 8                                   # Escuelas Aguirre, the station the model is trained on
TRAIN = ("2020-07-01", "2022-12-31")
VAL = ("2023-01-01", "2024-02-28")
FINAL_TRAIN = ("2020-07-01", "2024-02-28")    # train + validation, used for the test and the live forecast
TEST_FROM = "2024-02-29"
GROUP_KEYS = {"NO2 of the last days": "recent", "Day of the week / holiday": "weekday", "Season": "season",
              "Rain": "rain", "Wind": "wind", "Temperature & pressure": "temp",
              "Learning from last 30 days' errors": "correction"}


def r1(x):
    return None if x is None or not np.isfinite(x) else round(float(x), 1)


def period(t, a, b):
    return t[(t["date"] >= a) & (t["date"] <= b)]


def load():
    no2 = pd.read_csv("data/no2_daily.csv", parse_dates=["date"])
    obs = pd.read_csv("data/weather_era5.csv", parse_dates=["date"])
    fc = pd.read_csv("data/weather_forecast_ecmwf.csv", parse_dates=["date"])
    return no2, obs, fc


def station_meta() -> dict:
    s = pd.read_csv("data/stations.csv")
    return {int(r.station): {"lat": r.lat, "lon": r.lon, "type": r.type, "address": r.address} for r in s.itertuples()}


def pick_threshold(actual, pred, min_recall=0.85) -> float:
    """Highest alert threshold that still catches at least 85% of bad days (chosen on validation only)."""
    ok = [a for a in np.arange(20, 80, 1.0) if scores(actual, pred, alert_at=a)["recall"] >= min_recall]
    return float(max(ok))


def exceed_probability(pred, residuals_sorted) -> np.ndarray:
    """P(measured > LIMIT) when measured = expm1(log1p(pred) + e), e drawn from the validation errors."""
    need = np.log1p(LIMIT) - np.log1p(np.asarray(pred, float))
    return 1 - np.searchsorted(residuals_sorted, need, side="right") / len(residuals_sorted)


# ---------------------------------------------------------------------------------------------- evaluate
def evaluate():
    no2, obs, fc = load()
    T_obs = build_table(no2, STATION, obs, obs).dropna(subset=["target", "no2_today_to_18h"])
    T_fc = build_table(no2, STATION, obs, fc).dropna(subset=["target", "no2_today_to_18h", "temp_mean_tomorrow"])
    val, test = period(T_obs, *VAL), T_fc[T_fc["date"] >= TEST_FROM]
    train, train0 = period(T_obs, *TRAIN), period(T_obs, "2015-01-08", "2022-12-31")
    train_all = period(T_obs, "2015-01-08", "2024-02-28")
    m_val, final = AireManana().fit(train), AireManana().fit(period(T_obs, *FINAL_TRAIN))

    # thresholds and validation scores
    val_preds = {"persistence": baseline_persistence(val), "weekday": baseline_weekday_rule(train0, val),
                 "v1": m_val.predict(val), "v2": m_val.forecast(val)}
    th = {k: pick_threshold(val["target"], p) for k, p in val_preds.items()}
    validation = {k: scores(val["target"], p)["mean_abs_error"] for k, p in val_preds.items()}

    # final test (Escuelas Aguirre, ECMWF forecast from the day before)
    y = test["target"].to_numpy()
    preds = {"persistence": baseline_persistence(test), "weekday": baseline_weekday_rule(train_all, test),
             "v1": final.predict(test), "v2": final.forecast(test)}
    results = {k: {**scores(y, p, alert_at=th[k]), "alert_at": th[k], "bias": r1(np.nanmean(p - y))}
               for k, p in preds.items()}
    T_perfect = T_obs[T_obs["date"].isin(test["date"])]
    p_perf = final.forecast(T_perfect)
    results["v2_perfect_weather"] = {**scores(T_perfect["target"], p_perf, alert_at=th["v2"]), "alert_at": th["v2"],
                                     "bias": r1(np.nanmean(p_perf - T_perfect["target"].to_numpy()))}

    # alert trade-off: (false alarms, bad days caught) for every threshold
    bad = y > LIMIT
    tradeoff, budget = {}, {}
    for k, p in preds.items():
        pts = sorted({(int((~bad & (p > c)).sum()), int((bad & (p > c)).sum())) for c in np.arange(0, 120, 0.5)})
        tradeoff[k] = [list(x) for x in pts]
        budget[k] = {str(n): max(c for f, c in pts if f <= n) for n in (15, 30, 60)}

    # drift by year
    variants = {"absolute_2015": AireManana(relative=False).fit(train_all).predict(test),
                "relative_2015": AireManana().fit(train_all).predict(test), "v1": preds["v1"], "v2": preds["v2"]}
    years = test["tomorrow"].dt.year.to_numpy()
    drift = {k: [{"year": int(yr), "bias": r1(np.mean(p[years == yr] - y[years == yr])),
                  "mae": r1(np.mean(np.abs(p[years == yr] - y[years == yr])))} for yr in (2024, 2025, 2026)]
             for k, p in variants.items()}

    # daily series of the test period
    series = {"dates": test["tomorrow"].dt.strftime("%Y-%m-%d").tolist(), "measured": [r1(v) for v in y],
              "v2": [r1(v) for v in preds["v2"]], "v1": [r1(v) for v in preds["v1"]],
              "persistence": [r1(v) for v in preds["persistence"]]}

    # where it fails
    look = test.assign(pred=preds["v2"], persistence=preds["persistence"]).merge(
        obs.rename(columns={"date": "tomorrow", "rain": "rain_real", "wind_mean": "wind_real"})[
            ["tomorrow", "rain_real", "wind_real"]], on="tomorrow")

    def rows(d):
        return [{"date": f"{r.tomorrow:%Y-%m-%d}", "measured": r1(r.target), "forecast": r1(r.pred),
                 "today": r1(r.no2_today_to_18h), "rain": r1(r.rain_tomorrow), "wind": r1(r.wind_mean_tomorrow),
                 "calm_hours": r1(r.calm_hours_tomorrow)} for r in d.itertuples()]
    missed = look[(look["target"] > LIMIT) & (look["pred"] <= th["v2"])].sort_values("target", ascending=False)
    false_al = look[(look["target"] <= LIMIT) & (look["pred"] > th["v2"])]
    false_al = false_al.assign(err=false_al["pred"] - false_al["target"]).sort_values("err", ascending=False)
    by_month = []
    for m, g in look.groupby(look["tomorrow"].dt.month):
        by_month.append({"month": int(m), "model": r1(np.mean(np.abs(g["pred"] - g["target"]))),
                         "persistence": r1(np.mean(np.abs(g["persistence"] - g["target"]))),
                         "mean_no2": r1(g["target"].mean())})

    # every station (model trained on Escuelas Aguirre only) + validation errors for the uncertainty
    meta, per_station, val_errors, test_rows = station_meta(), [], [], []
    for st in sorted(no2["station"].unique()):
        st = int(st)
        Tv = period(build_table(no2, st, obs, obs).dropna(subset=["target", "no2_today_to_18h"]), *VAL)
        if len(Tv) > 100:
            e = np.log1p(Tv["target"].to_numpy()) - np.log1p(m_val.forecast(Tv))
            val_errors.append(e[np.isfinite(e)])
        Ts = build_table(no2, st, obs, fc).dropna(subset=["target", "no2_today_to_18h", "temp_mean_tomorrow"])
        Ts = Ts[Ts["date"] >= TEST_FROM]
        if len(Ts) < 200:
            continue
        p1, p2, pb = final.predict(Ts), final.forecast(Ts), baseline_persistence(Ts)
        s1, s2, sb = scores(Ts["target"], p1), scores(Ts["target"], p2, alert_at=th["v2"]), scores(Ts["target"], pb)
        per_station.append({"id": st, "name": STATIONS.get(st, str(st)), **meta.get(st, {}),
                            "mean_no2": r1(Ts["target"].mean()), "days": s2["days"],
                            "persistence_mae": sb["mean_abs_error"], "v1_mae": s1["mean_abs_error"],
                            "v2_mae": s2["mean_abs_error"],
                            "v1_gain": r1(100 * (1 - s1["mean_abs_error"] / sb["mean_abs_error"])),
                            "v2_gain": r1(100 * (1 - s2["mean_abs_error"] / sb["mean_abs_error"])),
                            "bad_days": s2["bad_days"], "caught": s2["caught"], "false_alarms": s2["false_alarms"]})
        test_rows.append(pd.DataFrame({"station": st, "y": Ts["target"].to_numpy(), "p": p2}))

    # uncertainty: validation errors -> quantiles; checked on the test period
    E = np.sort(np.concatenate(val_errors))
    q = np.quantile(E, np.linspace(0.005, 0.995, 199))
    Path("data/residuals.json").write_text(json.dumps([round(float(v), 4) for v in q]))
    allt = pd.concat(test_rows).dropna()
    lo = np.expm1(np.log1p(allt["p"]) + np.quantile(E, 0.10))
    hi = np.expm1(np.log1p(allt["p"]) + np.quantile(E, 0.90))
    coverage = float(np.mean((allt["y"] >= lo) & (allt["y"] <= hi)))
    pe, happened = exceed_probability(allt["p"], np.sort(q)), (allt["y"] > LIMIT).to_numpy()
    calib = []
    for a, b in [(0, 0.05), (0.05, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 1.01)]:
        k = (pe >= a) & (pe < b)
        if k.sum():
            calib.append({"from": a, "to": min(b, 1), "days": int(k.sum()), "predicted": round(float(pe[k].mean()), 3),
                          "observed": round(float(happened[k].mean()), 3)})

    # Madrid changed: yearly mean and days above the limit (Escuelas Aguirre) + city average
    s = no2.dropna(subset=["mean"]).assign(year=lambda d: d["date"].dt.year)
    city = s.groupby("year")["mean"].mean()
    decline = [{"year": int(yr), "mean": r1(g.mean()), "days_above": int((g > LIMIT).sum()), "days": int(g.size),
                "city_mean": r1(city[yr])} for yr, g in s[s["station"] == STATION].groupby("year")["mean"]]

    out = {
        "station": STATION, "limit": LIMIT, "thresholds": th, "alert_at": th["v2"],
        "data": {"hourly_values": int(no2["hours"].sum()), "station_days": int(len(no2)),
                 "stations": int(no2["station"].nunique()), "from": f"{no2['date'].min():%Y-%m-%d}",
                 "to": f"{no2['date'].max():%Y-%m-%d}", "train": list(FINAL_TRAIN), "validation": list(VAL),
                 "test": [TEST_FROM, f"{test['date'].max():%Y-%m-%d}"], "test_days": int(len(test)),
                 "test_bad_days": int(bad.sum())},
        "validation_mae": validation, "results": results, "tradeoff": tradeoff, "budget": budget, "drift": drift,
        "series": series, "missed": rows(missed.head(6)), "false_alarms": rows(false_al.head(4)), "by_month": by_month,
        "stations": per_station, "uncertainty": {"coverage_80": round(coverage, 3), "test_days": int(len(allt)),
                                                 "calibration": calib},
        "decline": decline,
    }
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "evaluation.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"evaluation.json written · v2 MAE {results['v2']['mean_abs_error']} vs persistence "
          f"{results['persistence']['mean_abs_error']} · 80% interval coverage {coverage:.1%}")
    for c in calib:
        print("  calibration", c)


# ---------------------------------------------------------------------------------------------- live
def live():
    no2, obs, _ = load()
    T = build_table(no2, STATION, obs, obs).dropna(subset=["target", "no2_today_to_18h"])
    final = AireManana().fit(period(T, *FINAL_TRAIN))
    alert_at = json.loads((WEB / "evaluation.json").read_text())["alert_at"]
    E = np.array(json.loads(Path("data/residuals.json").read_text()))
    now = pd.Timestamp.now(tz="Europe/Madrid")
    today = now.tz_localize(None).normalize()
    rt, wx = realtime_hourly(), weather_live()
    meta = station_meta()

    stations, measured = [], {}
    for st in STATIONS:
        try:
            f = forecast_tomorrow(final, st, alert_at=alert_at, realtime=rt, weather=wx, residuals=E, today=today)
        except Exception as e:                                     # station offline today: keep it on the map
            print(f"  {STATIONS[st]}: {e}")
            stations.append({"id": st, "name": STATIONS[st], **meta.get(st, {}), "status": "no_data"})
            continue
        h = f["history"].dropna()
        measured[st] = dict(zip(h["date"].dt.strftime("%Y-%m-%d"), h["mean"]))
        stations.append({
            "id": st, "name": f["station"], **meta.get(st, {}), "status": "ok",
            "forecast": r1(f["forecast"]), "low": r1(f["low"]), "high": r1(f["high"]),
            "p_exceed": round(f["p_exceed"], 3), "alert": bool(f["alert"]),
            "today_so_far": r1(f["today_so_far"]), "hours_today": f["hours_known_today"],
            "last_7_days": r1(f["last_7_days"]),
            "history": [[f"{d:%Y-%m-%d}", r1(v)] for d, v in zip(h["date"], h["mean"])],
            "why": [{"key": GROUP_KEYS[k], "pct": r1(v)} for k, v in f["why"].items()],
        })
        print(f"  {f['station']:22s} today {f['today_so_far']:5.1f} ({f['hours_known_today']:2d} h) -> "
              f"tomorrow {f['forecast']:5.1f} [{f['low']:.0f}-{f['high']:.0f}]  P(>50)={f['p_exceed']:.0%}")

    tomorrow = today + pd.Timedelta(days=1)
    w = wx[wx["date"] == tomorrow].iloc[0]
    out = {
        "issued": now.isoformat(timespec="minutes"), "today": f"{today:%Y-%m-%d}", "tomorrow": f"{tomorrow:%Y-%m-%d}",
        "holiday_tomorrow": tomorrow.date() in _HOLIDAYS, "limit": LIMIT, "alert_at": alert_at,
        "weather_tomorrow": {"rain": r1(w["rain"]), "wind": r1(w["wind_mean"]), "wind_max": r1(w["wind_max"]),
                             "calm_hours": r1(w["calm_hours"]), "temp_min": r1(w["temp_min"]),
                             "temp_max": r1(w["temp_max"]), "clouds": r1(w["clouds"]), "pressure": r1(w["pressure"])},
        "stations": stations,
    }
    out["track_record"] = update_log(out, measured)
    (WEB / "forecast.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"forecast.json written · issued {out['issued']} for {out['tomorrow']}")


def update_log(out: dict, measured: dict) -> dict:
    """Keep every published forecast (one row per day and station) and check it once the day has been measured:
    a truly unseen test that grows every day."""
    path = WEB / "log.csv"
    new = pd.DataFrame([{"issued": out["today"], "for_day": out["tomorrow"], "station": s["id"],
                         "forecast": s["forecast"], "low": s["low"], "high": s["high"], "p_exceed": s["p_exceed"],
                         "alert": s["alert"]} for s in out["stations"] if s["status"] == "ok"])
    log = pd.read_csv(path) if path.exists() else new.assign(measured=np.nan).iloc[:0]
    log = pd.concat([log[log["issued"] != out["today"]], new], ignore_index=True)
    old = log["measured"] if "measured" in log else pd.Series(np.nan, index=log.index)
    log["measured"] = [measured.get(int(r.station), {}).get(r.for_day, m) if r.for_day < out["today"] else np.nan
                       for r, m in zip(log.itertuples(), old)]
    log.to_csv(path, index=False)
    done = log.dropna(subset=["measured"])
    main = done[done["station"] == STATION].sort_values("for_day")
    return {"since": str(log["issued"].min()), "published": int(log["issued"].nunique()),
            "verified_days": int(done["for_day"].nunique()), "verified_forecasts": int(len(done)),
            "mae": r1(np.mean(np.abs(done["forecast"] - done["measured"]))) if len(done) else None,
            "main_station": [{"day": r.for_day, "forecast": r1(r.forecast), "measured": r1(r.measured)}
                             for r in main.tail(14).itertuples()]}


if __name__ == "__main__":
    {"evaluate": evaluate, "live": live}[sys.argv[1] if len(sys.argv) > 1 else "live"]()
