"""Build the data files of the AireMañana website (web/).

    python make_site_data.py evaluate   # once: test-period results -> web/data/evaluation.json + data/residuals.json
    python make_site_data.py live       # every evening: tomorrow's forecast for all 24 stations -> web/data/forecast.json
                                        #   (also rewrites the calendar feeds, see `calendars`)
    python make_site_data.py profiles   # once: typical hour-by-hour shape of NO2 per station -> web/data/profiles.json
    python make_site_data.py schools    # once: Madrid's schools and their nearest station -> web/data/schools.json
    python make_site_data.py calendars  # calendar feeds (.ics) per station from forecast.json + log.csv -> web/cal/

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
from madrid_data import NO2, STATIONS, read_history, realtime_hourly, weather_live

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
    calendars()


def update_log(out: dict, measured: dict) -> dict:
    """Keep every published forecast (one row per day and station) and check it once the day has been measured:
    a truly unseen test that grows every day."""
    path = WEB / "log.csv"
    new = pd.DataFrame([{"issued": out["today"], "for_day": out["tomorrow"], "station": s["id"],
                         "forecast": s["forecast"], "low": s["low"], "high": s["high"], "p_exceed": s["p_exceed"],
                         "alert": s["alert"], "persistence": s["today_so_far"]}
                        for s in out["stations"] if s["status"] == "ok"])
    log = pd.read_csv(path) if path.exists() else new.assign(measured=np.nan).iloc[:0]
    log = pd.concat([log[log["issued"] != out["today"]], new], ignore_index=True)
    old = log["measured"] if "measured" in log else pd.Series(np.nan, index=log.index)
    log["measured"] = [measured.get(int(r.station), {}).get(r.for_day, m) if r.for_day < out["today"] else np.nan
                       for r, m in zip(log.itertuples(), old)]
    log.to_csv(path, index=False)
    done = log.dropna(subset=["measured"])
    base = done.dropna(subset=["persistence"]) if "persistence" in done else done.iloc[:0]   # baseline saved since 14-11
    main = done[done["station"] == STATION].sort_values("for_day")
    return {"since": str(log["issued"].min()), "published": int(log["issued"].nunique()),
            "verified_days": int(done["for_day"].nunique()), "verified_forecasts": int(len(done)),
            "mae": r1(np.mean(np.abs(done["forecast"] - done["measured"]))) if len(done) else None,
            "mae_persistence": (r1(np.mean(np.abs(base["persistence"] - base["measured"]))) if len(base) else None),
            "mae_same_rows": (r1(np.mean(np.abs(base["forecast"] - base["measured"]))) if len(base) else None),
            "alerts": int(log["alert"].astype(str).eq("True").sum()),
            "main_station": [{"day": r.for_day, "forecast": r1(r.forecast), "measured": r1(r.measured)}
                             for r in main.tail(14).itertuples()]}


# ---------------------------------------------------------------------------------------------- profiles
SCHOOL_HOURS = range(9, 17)                  # clock hours 09:00-17:00 (Madrid's hourly files: H10 = 09:00-10:00)
WINDOWS = list(range(9, 16))                 # 2-hour PE windows that start at 09:00 ... 15:00


def day_type(dates: pd.Series) -> pd.Series:
    """0 = school day (Mon-Fri, not a holiday), 1 = Saturday, 2 = Sunday or public holiday."""
    hol = dates.dt.date.map(lambda d: d in _HOLIDAYS)
    return np.where(hol | (dates.dt.day_of_week == 6), 2, np.where(dates.dt.day_of_week == 5, 1, 0))


def season(dates: pd.Series) -> np.ndarray:
    """0 = cold half of the year (October-March), 1 = warm half (April-September)."""
    return np.where(dates.dt.month.isin([4, 5, 6, 7, 8, 9]), 1, 0)


def hourly_table(hourly: pd.DataFrame) -> pd.DataFrame:
    """One row per station and day, 24 columns = NO2 of each clock hour (0 = 00:00-01:00). Days with a missing
    hour are dropped, so every day has a complete shape."""
    h = hourly[(hourly["pollutant"] == NO2) & hourly["station"].isin(STATIONS)]
    w = h.pivot_table(index=["station", "date"], columns="hour", values="value").dropna()
    w.columns = [c - 1 for c in w.columns]
    w = w.reset_index()
    w["day_type"], w["season"] = day_type(w["date"]), season(w["date"])
    return w


def best_window(shape) -> int:
    """Start hour of the 2-hour school window with the lowest NO2 in a 24-value shape."""
    return min(WINDOWS, key=lambda a: shape[a] + shape[a + 1])


def profiles():
    """Typical shape of a day at each station (hour value / day mean), learned on the same years as the model
    (Jul 2020 - Feb 2024), then checked on the test period: was the suggested PE window really cleaner?"""
    w = hourly_table(read_history())
    hrs = list(range(24))
    w["mean"] = w[hrs].mean(axis=1)
    learn = w[(w["date"] >= FINAL_TRAIN[0]) & (w["date"] <= FINAL_TRAIN[1]) & (w["mean"] >= 5)]
    ratio = learn[hrs].div(learn["mean"], axis=0)
    shape = ratio.groupby([learn["station"], learn["day_type"], learn["season"]]).mean()
    shape = shape.div(shape.mean(axis=1), axis=0)                      # each shape averages exactly 1

    # check on the test period, school days only (the same days the forecast was tested on)
    test = w[(w["date"] >= TEST_FROM) & (w["day_type"] == 0)].copy()
    pick_of = {k: WINDOWS.index(best_window(shape.loc[k].to_numpy())) for k in shape.index}
    keys = list(zip(test["station"], [0] * len(test), test["season"]))
    ok = np.array([k in pick_of for k in keys])
    test, keys = test[ok], [k for k, o in zip(keys, ok) if o]
    V = test[hrs].to_numpy()
    win = np.stack([(V[:, a] + V[:, a + 1]) / 2 for a in WINDOWS], axis=1)       # NO2 in each 2-hour window
    p = np.array([pick_of[k] for k in keys])
    picked = win[np.arange(len(win)), p]
    rank = (win < picked[:, None]).sum(axis=1) + 1
    ev = pd.DataFrame({"station": test["station"].to_numpy(), "date": test["date"].to_numpy(), "picked": picked,
                       "best": win.min(axis=1), "worst": win.max(axis=1), "morning": win[:, 0],
                       "school_day": V[:, list(SCHOOL_HOURS)].mean(axis=1), "hit": rank == 1, "rank": rank})
    check = {
        "station_days": int(len(ev)), "stations": int(ev["station"].nunique()),
        "from": f"{ev['date'].min():%Y-%m-%d}", "to": f"{ev['date'].max():%Y-%m-%d}",
        "picked": r1(ev["picked"].mean()), "school_day": r1(ev["school_day"].mean()), "morning": r1(ev["morning"].mean()),
        "best_possible": r1(ev["best"].mean()), "worst": r1(ev["worst"].mean()),
        "less_than_school_day_pct": r1(100 * (1 - ev["picked"].mean() / ev["school_day"].mean())),
        "less_than_morning_pct": r1(100 * (1 - ev["picked"].mean() / ev["morning"].mean())),
        "was_cleanest_pct": r1(100 * ev["hit"].mean()), "top2_pct": r1(100 * (ev["rank"] <= 2).mean()),
        "cleaner_than_school_day_pct": r1(100 * (ev["picked"] < ev["school_day"]).mean()),
    }
    out = {"note": "hour value / day mean, learned Jul 2020 - Feb 2024; hour 0 = 00:00-01:00",
           "windows": WINDOWS, "check": check,
           "shape": {str(st): {f"{dt}{se}": [round(float(x), 3) for x in shape.loc[(st, dt, se)]]
                               for (s2, dt, se) in shape.index if s2 == st}
                     for st in sorted({k[0] for k in shape.index})}}
    (WEB / "profiles.json").write_text(json.dumps(out, separators=(",", ":")))
    print(json.dumps(check, indent=1))


# ---------------------------------------------------------------------------------------------- schools
SCHOOLS_URL = "https://datos.madrid.es/egob/catalogo/300614-0-centros-educativos.csv"
SCHOOL_TYPES = ["ColegiosPublicos", "ColegiosPrivadosConcertados", "InstitutosEnseñanzaSecundaria",
                "EscuelasInfantilesPublicas", "EscuelasInfantilesPrivadasGuarderias",
                "CentrosPublicosEducacionEspecial", "CentrosPrivadosConcertadosEducacionEspecial"]
SHORT = [("Instituto de Educación Secundaria (IES) ", "IES "), ("Colegio Público de Educación Especial ", "CPEE "),
         ("Colegio Público ", "CEIP "), ("Escuela infantil municipal ", "Escuela Infantil Municipal ")]


def km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    p1, p2, dl = np.radians(lat1), np.radians(lat2), np.radians(np.asarray(lon2) - lon1)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 6371 * 2 * np.arcsin(np.sqrt(a))


def schools():
    """Madrid City Council's list of schools and nurseries (CC BY 4.0) + the nearest of the 24 stations."""
    import io
    import requests
    raw = requests.get(SCHOOLS_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=120).content
    d = pd.read_csv(io.BytesIO(raw), sep=";", encoding="latin1", dtype=str)
    d["kind"] = d["TIPO"].fillna("").str.rsplit("/", n=1).str[-1]
    d = d[d["kind"].isin(SCHOOL_TYPES)].copy()
    d["lat"], d["lon"] = pd.to_numeric(d["LATITUD"], errors="coerce"), pd.to_numeric(d["LONGITUD"], errors="coerce")
    d = d.dropna(subset=["lat", "lon"])
    d = d[d["lat"].between(40.2, 40.7) & d["lon"].between(-3.95, -3.5)]
    st = pd.read_csv("data/stations.csv")
    st = st[st["station"].isin(STATIONS)]
    dist = np.stack([km(r.lat, r.lon, d["lat"].to_numpy(), d["lon"].to_numpy()) for r in st.itertuples()], axis=1)
    d["station"] = st["station"].to_numpy()[dist.argmin(axis=1)]
    d["km"] = dist.min(axis=1)

    def short(n):
        n = " ".join(str(n).split())
        for a, b in SHORT:
            if n.startswith(a):
                return b + n[len(a):]
        return n

    d = d.sort_values("NOMBRE")
    rows = [[int(r.PK), short(r.NOMBRE), SCHOOL_TYPES.index(r.kind), round(r.lat, 5), round(r.lon, 5), int(r.station),
             round(float(r.km), 2), str(r.DISTRITO).title() if isinstance(r.DISTRITO, str) else "",
             str(r.BARRIO).title() if isinstance(r.BARRIO, str) else ""] for r in d.itertuples()]
    out = {"source": "Ayuntamiento de Madrid, Centros educativos (datos.madrid.es, CC BY 4.0)",
           "downloaded": f"{pd.Timestamp.now():%Y-%m-%d}", "types": SCHOOL_TYPES,
           "fields": ["id", "name", "type", "lat", "lon", "station", "km", "district", "neighbourhood"], "schools": rows}
    (WEB / "schools.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(rows)} schools · median distance to the nearest station {d['km'].median():.1f} km · "
          f"{(d['km'] <= 2).mean():.0%} within 2 km · max {d['km'].max():.1f} km")
    print(d["kind"].value_counts().to_string())


# ---------------------------------------------------------------------------------------------- calendars
SITE = "https://julianjms-beep.github.io/aire-manana/"
CAL = Path("web/cal")
CAL_TEXT = {
    "en": {"ok": "🟢 Outdoor PE OK", "watch": "🟡 Outdoor OK, keep an eye", "alert": "🔴 PE indoors",
           "verdict": {"ok": "Outdoor PE and recess are fine.", "watch": "Outdoor activity is fine — keep an eye on it.",
                       "alert": "Move PE and recess indoors."},
           "range": "Likely range", "chance": "Chance above the EU limit (50 µg/m³)", "best": "Cleanest school hours", "best_free": "Cleanest daytime hours (no school tomorrow)",
           "measured": "measured", "name": "AireMañana · {s}", "desc": "Tomorrow's NO₂ at {s}, Madrid. Updated every evening after 18:30.",
           "note": "Prototype, not medical advice.", "typical": "(typical shape of the day)"},
    "es": {"ok": "🟢 EF fuera: sí", "watch": "🟡 EF fuera, vigilar", "alert": "🔴 EF dentro",
           "verdict": {"ok": "Educación Física y recreo, al aire libre.", "watch": "Se puede salir — pero conviene vigilarlo.",
                       "alert": "Educación Física y recreo, mejor dentro."},
           "range": "Rango probable", "chance": "Probabilidad de superar el límite UE (50 µg/m³)",
           "best": "Horas más limpias del horario escolar",
           "best_free": "Horas más limpias del día (mañana no hay cole)", "measured": "medido",
           "name": "AireMañana · {s}", "desc": "El NO₂ de mañana en {s} (Madrid). Se actualiza cada tarde después de las 18:30.",
           "note": "Prototipo, no es consejo médico.", "typical": "(forma típica del día)"},
}


def level(forecast, alert) -> str:
    return "alert" if alert else "watch" if forecast >= 35 else "ok"


def _ics_text(x: str) -> str:
    return str(x).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _fold(line: str) -> str:
    """RFC 5545: lines longer than 75 octets continue on the next line after a space."""
    out, cur = [], b""
    for ch in line:
        c = ch.encode()
        if len(cur) + len(c) > (75 if not out else 74):
            out.append(cur.decode())
            cur = b""
        cur += c
    out.append(cur.decode())
    return "\r\n ".join(out)


def calendars():
    """One subscribable calendar per station and language. Each evening's run adds tomorrow's event and keeps the
    last 14 days (with the measured value once known), so a teacher sees the decision in their own calendar app."""
    F = json.loads((WEB / "forecast.json").read_text())
    log = pd.read_csv(WEB / "log.csv")
    P = json.loads((WEB / "profiles.json").read_text())
    tomorrow = pd.Timestamp(F["tomorrow"])
    dt_key = f"{day_type(pd.Series([tomorrow]))[0]}{season(pd.Series([tomorrow]))[0]}"
    stamp = pd.Timestamp.now(tz="UTC").strftime("%Y%m%dT%H%M%SZ")
    CAL.mkdir(parents=True, exist_ok=True)
    keep = log[log["for_day"] >= f"{tomorrow - pd.Timedelta(days=14):%Y-%m-%d}"]
    for s in F["stations"]:
        shape = P["shape"].get(str(s["id"]), {}).get(dt_key)
        start = best_window(shape) if shape else None
        for lang, T in CAL_TEXT.items():
            ev = []
            for r in keep[keep["station"] == s["id"]].sort_values("for_day").itertuples():
                lv = level(r.forecast, str(r.alert) == "True")
                title = f"{T[lv]} · {r.forecast:.0f} µg/m³"
                if pd.notna(r.measured):
                    title += f" ({T['measured']} {r.measured:.0f})"
                desc = [T["verdict"][lv], f"{T['range']}: {r.low:.0f}–{r.high:.0f} µg/m³",
                        f"{T['chance']}: {'<1' if r.p_exceed < 0.01 else f'{100 * r.p_exceed:.0f}'} %"]
                if r.for_day == F["tomorrow"] and start is not None:
                    label = T["best"] if dt_key[0] == "0" else T["best_free"]
                    desc.append(f"{label}: {start:02d}:00–{start + 2:02d}:00 {T['typical']}")
                desc += [f"{SITE}?st={s['id']}&lang={lang}", T["note"]]
                d0 = pd.Timestamp(r.for_day)
                ev += ["BEGIN:VEVENT", f"UID:{r.for_day}-st{s['id']}-{lang}@aire-manana", f"DTSTAMP:{stamp}",
                       f"DTSTART;VALUE=DATE:{d0:%Y%m%d}", f"DTEND;VALUE=DATE:{d0 + pd.Timedelta(days=1):%Y%m%d}",
                       f"SUMMARY:{_ics_text(title)}", f"DESCRIPTION:{_ics_text(chr(10).join(desc))}",
                       f"URL:{SITE}?st={s['id']}&lang={lang}", "TRANSP:TRANSPARENT", "END:VEVENT"]
            lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AireManana//NO2 forecast Madrid//EN",
                     "CALSCALE:GREGORIAN", "METHOD:PUBLISH", f"X-WR-CALNAME:{_ics_text(T['name'].format(s=s['name']))}",
                     f"X-WR-CALDESC:{_ics_text(T['desc'].format(s=s['name']))}", "X-WR-TIMEZONE:Europe/Madrid",
                     "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", *ev, "END:VCALENDAR"]
            (CAL / f"{s['id']}-{lang}.ics").write_bytes(("\r\n".join(_fold(x) for x in lines) + "\r\n").encode())
    print(f"calendars written for {len(F['stations'])} stations × 2 languages -> {CAL}/")


if __name__ == "__main__":
    {"evaluate": evaluate, "live": live, "profiles": profiles, "schools": schools,
     "calendars": calendars}[sys.argv[1] if len(sys.argv) > 1 else "live"]()
