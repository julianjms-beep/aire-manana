"""Live forecast: tomorrow's NO2 for a Madrid station, with the alert and a plain-language explanation."""
from __future__ import annotations

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from forecast_model import LIMIT, build_table
from madrid_data import STATIONS, daily, recent_hourly, weather_live

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def forecast_tomorrow(model, station: int = 8, alert_at: float = LIMIT, realtime: pd.DataFrame | None = None,
                      weather: pd.DataFrame | None = None, residuals: np.ndarray | None = None,
                      today: pd.Timestamp | None = None) -> dict:
    """Use the newest real data: NO2 up to now (EEA + Madrid real-time) and the ECMWF forecast.

    `residuals`: the model's log-scale errors on validation data; if given, the forecast also gets a likely
    range (10th-90th percentile) and the probability of going above the EU limit.
    `today`: the day the forecast is made (default: the newest day with data). Raises ValueError if the
    station has no measurements for that day."""
    hourly = recent_hourly(station, realtime)
    no2 = daily(hourly)
    weather = weather_live() if weather is None else weather
    table = build_table(no2, station, weather, weather)
    today = table["date"].max() if today is None else pd.Timestamp(today).normalize()
    so_far_hours = hourly[(hourly["date"] == today) & (hourly["hour"] <= 18)]["value"]
    if so_far_hours.empty:
        raise ValueError(f"station {station}: no measurements yet on {today:%Y-%m-%d}")
    if pd.isna(table.loc[table["date"] == today, "no2_today_to_18h"]).all():
        # Before ~14:00 there are not enough hours yet: use what we have so far (noted in the output).
        table.loc[table["date"] == today, "no2_today_to_18h"] = so_far_hours.mean()
    table = table[(table["date"] >= today - pd.Timedelta(days=45)) & (table["date"] <= today)]
    table = table.dropna(subset=["no2_today_to_18h", "temp_mean_tomorrow"])
    pred = float(model.forecast(table)[-1])          # last row = today -> forecast for tomorrow
    row = table[table["date"] == today]
    raw = float(model.predict(row)[0])
    why = model.explain(row).iloc[0]
    why["Learning from last 30 days' errors"] = (pred / raw - 1) * 100
    why = why.sort_values(key=np.abs, ascending=False)
    out = {
        "station": STATIONS.get(station, str(station)), "station_id": station, "today": today,
        "tomorrow": today + pd.Timedelta(days=1), "hours_known_today": int(so_far_hours.size),
        "forecast": pred, "alert": pred > alert_at, "alert_at": alert_at,
        "today_so_far": float(row["no2_today_to_18h"].iloc[0]), "why": why,
        "last_7_days": float(row["no2_last_7_days"].iloc[0]),
        "history": no2[no2["date"] < today].tail(28)[["date", "mean"]],
        "weather_tomorrow": weather[weather["date"] == today + pd.Timedelta(days=1)].iloc[0],
    }
    if residuals is not None:
        sims = np.expm1(np.log1p(pred) + np.asarray(residuals))
        out["low"], out["high"] = (float(v) for v in np.percentile(sims, [10, 90]))
        out["p_exceed"] = float(np.mean(sims > LIMIT))
    return out


def show(f: dict, save: str | None = None):
    """Print and draw the forecast card."""
    day = DAYS[f["tomorrow"].dayofweek]
    verdict = ("ALERT: keep PE and recess indoors tomorrow" if f["alert"]
               else "OK: outdoor activity is fine tomorrow")
    w = f["weather_tomorrow"]
    print(f"AireMañana · {f['station']} · forecast made {f['today']:%d %b %Y} for {day} {f['tomorrow']:%d %b}")
    print(f"Tomorrow's mean NO2: {f['forecast']:.0f} µg/m³ (EU 2030 daily limit: {LIMIT:.0f}) -> {verdict}")
    print(f"Today so far: {f['today_so_far']:.0f} µg/m³ ({f['hours_known_today']} hours measured)")
    print(f"Weather tomorrow (ECMWF): rain {w['rain']:.1f} mm, wind {w['wind_mean']:.0f} km/h, "
          f"{w['calm_hours']:.0f} calm hours, {w['temp_min']:.0f}-{w['temp_max']:.0f} °C")
    print("Why (effect on tomorrow vs. today, compared with a typical day):", ", ".join(f"{k} {v:+.0f}%" for k, v in f["why"].items() if abs(v) >= 1))

    fig, (a, b) = plt.subplots(1, 2, figsize=(13, 4.4), gridspec_kw={"width_ratios": [1.5, 1]})
    h = f["history"].tail(14)
    a.bar(h["date"], h["mean"], color="#9bb7d4", label="measured (daily mean)")
    a.bar([f["today"]], [f["today_so_far"]], color="white", edgecolor="#6b8fb5", hatch="///",
          label=f"today so far ({f['hours_known_today']} h)")
    a.bar([f["tomorrow"]], [f["forecast"]], color="#d9534f" if f["alert"] else "#5cb85c",
          label="AireMañana forecast")
    a.axhline(LIMIT, color="k", ls="--", lw=1)
    a.text(f["tomorrow"], LIMIT + 1.5, "EU 2030 daily limit", fontsize=9, ha="right")
    a.set_ylim(0, max(LIMIT, h["mean"].max(), f["forecast"]) * 1.25)
    a.set_ylabel("NO2 (µg/m³)")
    a.set_title(f"{f['station']}: tomorrow ({day}) {f['forecast']:.0f} µg/m³ — {'ALERT' if f['alert'] else 'OK'}")
    a.legend(loc="upper left", fontsize=8)
    a.xaxis.set_major_formatter(plt.matplotlib.dates.DateFormatter("%d %b"))
    a.tick_params(axis="x", rotation=45)
    why = f["why"][::-1]
    b.barh(why.index, why.values, color=["#d9534f" if v > 0 else "#5cb85c" for v in why.values])
    b.axvline(0, color="k", lw=0.8)
    b.set_xlabel("effect on tomorrow vs. today (%)\ncompared with a typical day")
    b.set_title("Why?")
    fig.tight_layout()
    if save:
        fig.savefig(save, dpi=150)
    plt.show()
