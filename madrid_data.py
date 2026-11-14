"""Download and clean the data: Madrid's official air-quality network + Open-Meteo weather.

Sources (all public, no API key needed):
- Madrid City Council, "Calidad del aire. Datos horarios desde 2001" (hourly, validated, monthly updates)
  https://datos.madrid.es/dataset/201200-0-calidad-aire-horario
- Madrid City Council, "Calidad del aire. Tiempo real" (today's hours)
  https://datos.madrid.es/dataset/212531-0-calidad-aire-tiempo-real
- European Environment Agency, up-to-date air quality data (E2a, last days)
  https://eeadmz1-downloads-webapp.azurewebsites.net/
- Open-Meteo: ERA5 reanalysis (past weather), Previous Runs API (archived ECMWF forecasts made the day
  before) and Forecast API (tomorrow's forecast).  https://open-meteo.com
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

NO2 = 8                 # Madrid's code for nitrogen dioxide (µg/m³)
MIN_HOURS_DAY = 18      # a day only counts if at least 18 of its 24 hours are valid
DECISION_HOUR = 18      # the alert is issued at 18:00 using today's hours 00:00-18:00
MIN_HOURS_TO_18 = 14

STATIONS = {8: "Escuelas Aguirre", 56: "Plaza Elíptica", 24: "Casa de Campo", 4: "Plaza de España",
            11: "Av. Ramón y Cajal", 16: "Arturo Soria", 17: "Villaverde", 18: "Farolillo",
            27: "Barajas Pueblo", 35: "Plaza del Carmen", 36: "Moratalaz", 38: "Cuatro Caminos",
            39: "Barrio del Pilar", 40: "Vallecas", 47: "Méndez Álvaro", 48: "Castellana",
            49: "Parque del Retiro", 50: "Plaza Castilla", 54: "Ensanche de Vallecas",
            55: "Urb. Embajada", 57: "Sanchinarro", 58: "El Pardo", 59: "Juan Carlos I", 60: "Tres Olivos"}

_HEADERS = {"User-Agent": "Mozilla/5.0"}
_BASE = "https://datos.madrid.es/dataset/201200-0-calidad-aire-horario/resource"
_YEAR_RESOURCE = {2015: 26, 2016: 25, 2017: 7, 2018: 18, 2019: 6, 2020: 4,
                  2021: 5, 2022: 23, 2023: 3, 2024: 0}
_SINCE_2025 = f"{_BASE}/201200-1-calidad-aire-horario-csv/download/201200-1-calidad-aire-horario-csv.csv"
_REALTIME = ("https://datos.madrid.es/dataset/212531-0-calidad-aire-tiempo-real/resource/"
             "212531-2-calidad-aire-tiempo-real/download/212531-2-calidad-aire-tiempo-real.csv")


# ------------------------------------------------------------------ air quality
def download_history(folder: str | Path = "data/raw") -> None:
    """Download the yearly files that are missing (about 85 MB)."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for year, n in _YEAR_RESOURCE.items():
        dest = folder / f"{year}.zip"
        if not dest.exists():
            url = f"{_BASE}/201200-{n}-calidad-aire-horario-zip/download/201200-{n}-calidad-aire-horario-zip.zip"
            dest.write_bytes(requests.get(url, headers=_HEADERS, timeout=300).content)
    dest = folder / "since2025.csv"
    if not dest.exists():
        dest.write_bytes(requests.get(_SINCE_2025, headers=_HEADERS, timeout=300).content)


def _read_madrid_csv(f) -> pd.DataFrame:
    df = pd.read_csv(f, sep=";", dtype=str, encoding="utf-8-sig")
    df.columns = [c.strip().strip('"').upper() for c in df.columns]
    return df


def _wide_to_long(wide: pd.DataFrame) -> pd.DataFrame:
    """Madrid files have one row per station/pollutant/day and 24 hour columns (H01 = 00:00-01:00)
    each followed by a validity flag (V = valid). Turn that into one row per valid hour."""
    parts = []
    for h in range(1, 25):
        p = wide[["ESTACION", "MAGNITUD", "ANO", "MES", "DIA", f"H{h:02d}", f"V{h:02d}"]].copy()
        p.columns = ["station", "pollutant", "y", "m", "d", "value", "flag"]
        p["hour"] = h
        parts.append(p)
    long = pd.concat(parts, ignore_index=True)
    long = long[long["flag"] == "V"]
    long["value"] = pd.to_numeric(long["value"], errors="coerce")
    long = long.dropna(subset=["value"])
    long["station"] = long["station"].astype(int)
    long["pollutant"] = long["pollutant"].astype(int)
    long["date"] = pd.to_datetime(long["y"] + "-" + long["m"].str.zfill(2) + "-" + long["d"].str.zfill(2),
                                  errors="coerce")
    return long.dropna(subset=["date"])[["station", "pollutant", "date", "hour", "value"]]


def read_history(folder: str | Path = "data/raw") -> pd.DataFrame:
    """All validated hourly measurements, 2015 to the last published month."""
    folder = Path(folder)
    frames = []
    for z in sorted(folder.glob("*.zip")):
        with zipfile.ZipFile(z) as zf:
            frames += [_read_madrid_csv(io.BytesIO(zf.read(n))) for n in zf.namelist() if n.lower().endswith(".csv")]
    frames.append(_read_madrid_csv(folder / "since2025.csv"))
    return _wide_to_long(pd.concat(frames, ignore_index=True))


def daily(hourly: pd.DataFrame, pollutant: int = NO2) -> pd.DataFrame:
    """Per station and day: 24-hour mean, mean of 00:00-18:00 (what is known at 18:00), max, valid hours."""
    d = hourly[hourly["pollutant"] == pollutant]
    g = d.groupby(["station", "date"])["value"].agg(mean="mean", max="max", hours="count")
    early = d[d["hour"] <= DECISION_HOUR].groupby(["station", "date"])["value"].agg(
        mean_to_18h="mean", hours_to_18h="count")
    g = g.join(early).reset_index()
    g.loc[g["hours"] < MIN_HOURS_DAY, ["mean", "max"]] = np.nan
    g.loc[g["hours_to_18h"] < MIN_HOURS_TO_18, "mean_to_18h"] = np.nan
    return g


def realtime_hourly() -> pd.DataFrame:
    """Today's hourly values for every station and pollutant (Madrid real-time file, updated every hour)."""
    rt = _read_madrid_csv(io.BytesIO(requests.get(_REALTIME, headers=_HEADERS, timeout=60).content))
    return _wide_to_long(rt)


def recent_hourly(station: int, realtime: pd.DataFrame | None = None) -> pd.DataFrame:
    """Last weeks of hourly NO2 for one station: EEA up-to-date data (up to yesterday) + Madrid's
    real-time file (today). Used only for the live forecast. Pass `realtime` to avoid downloading
    the real-time file again for every station."""
    code = f"SP_28079{station:03d}_8_8"
    url = f"https://eeadmz1batchservice02.blob.core.windows.net/airquality-p/ES/{code}.parquet"
    e = pd.read_parquet(io.BytesIO(requests.get(url, headers=_HEADERS, timeout=120).content))
    e["value"] = pd.to_numeric(e["Value"], errors="coerce")
    e = e[(e["Validity"] > 0) & (e["value"] >= 0)]
    # EEA timestamps are fixed UTC+1; Madrid's files use local time (UTC+1 in winter, UTC+2 in summer).
    end = pd.to_datetime(e["End"]).dt.tz_localize("Etc/GMT-1").dt.tz_convert("Europe/Madrid").dt.tz_localize(None)
    start = end - pd.Timedelta(hours=1)
    eea = pd.DataFrame({"station": station, "pollutant": NO2, "date": start.dt.normalize(),
                        "hour": start.dt.hour + 1, "value": e["value"].to_numpy()})

    rt = realtime_hourly() if realtime is None else realtime
    rt = rt[(rt["station"] == station) & (rt["pollutant"] == NO2)]
    both = pd.concat([eea[~eea["date"].isin(rt["date"].unique())], rt], ignore_index=True)
    return both.sort_values(["date", "hour"])


# ------------------------------------------------------------------ weather (Open-Meteo)
LAT, LON = 40.4215, -3.6823   # central Madrid (Escuelas Aguirre)
HOURLY_VARS = ["temperature_2m", "relative_humidity_2m", "precipitation", "pressure_msl",
               "cloud_cover", "wind_speed_10m", "wind_direction_10m"]
WEATHER = ["temp_mean", "temp_max", "temp_min", "temp_range", "humidity", "rain", "pressure", "clouds",
           "wind_mean", "wind_max", "wind_u", "wind_v", "calm_hours"]


def _to_daily_weather(h: pd.DataFrame) -> pd.DataFrame:
    """Summarise hourly weather into the daily numbers that matter for pollution."""
    h = h.copy()
    h["date"] = h["time"].dt.normalize()
    rad = np.deg2rad(h["wind_direction_10m"])
    h["u"] = -h["wind_speed_10m"] * np.sin(rad)   # west -> east component
    h["v"] = -h["wind_speed_10m"] * np.cos(rad)   # south -> north component
    h["calm"] = (h["wind_speed_10m"] < 6).astype(float)  # hours with almost no wind (< 6 km/h)
    g = h.groupby("date")
    out = pd.DataFrame({
        "temp_mean": g["temperature_2m"].mean(), "temp_max": g["temperature_2m"].max(),
        "temp_min": g["temperature_2m"].min(), "humidity": g["relative_humidity_2m"].mean(),
        "rain": g["precipitation"].sum(), "pressure": g["pressure_msl"].mean(),
        "clouds": g["cloud_cover"].mean(), "wind_mean": g["wind_speed_10m"].mean(),
        "wind_max": g["wind_speed_10m"].max(), "wind_u": g["u"].mean(), "wind_v": g["v"].mean(),
        "calm_hours": g["calm"].sum(),
    })
    out["temp_range"] = out["temp_max"] - out["temp_min"]  # big day/night swing = stable, stagnant air
    return out.reset_index()[["date"] + WEATHER]


def _get_hourly(url: str, params: dict) -> pd.DataFrame:
    r = requests.get(url, params=params, timeout=300)
    r.raise_for_status()
    h = pd.DataFrame(r.json()["hourly"])
    h["time"] = pd.to_datetime(h["time"])
    return h


def weather_observed(start: str, end: str, cache: str | Path = "data/weather_era5.csv") -> pd.DataFrame:
    """The weather that actually happened (ECMWF ERA5 reanalysis), one row per day."""
    cache = Path(cache)
    if cache.exists():
        return pd.read_csv(cache, parse_dates=["date"])
    h = _get_hourly("https://archive-api.open-meteo.com/v1/archive",
                    {"latitude": LAT, "longitude": LON, "start_date": start, "end_date": end,
                     "hourly": ",".join(HOURLY_VARS), "timezone": "Europe/Madrid"})
    d = _to_daily_weather(h)
    cache.parent.mkdir(parents=True, exist_ok=True)
    d.to_csv(cache, index=False)
    return d


def weather_forecast_day_before(start: str, end: str, cache: str | Path = "data/weather_forecast_ecmwf.csv"
                                ) -> pd.DataFrame:
    """What the ECMWF forecast said one day earlier (Open-Meteo archive of previous runs, from 2024)."""
    cache = Path(cache)
    if cache.exists():
        return pd.read_csv(cache, parse_dates=["date"])
    suffix = "_previous_day1"
    parts = []
    a, b = pd.Timestamp(start), pd.Timestamp(end)
    while a <= b:
        c = min(a + pd.DateOffset(months=6) - pd.Timedelta(days=1), b)
        h = _get_hourly("https://previous-runs-api.open-meteo.com/v1/forecast",
                        {"latitude": LAT, "longitude": LON, "start_date": a.strftime("%Y-%m-%d"),
                         "end_date": c.strftime("%Y-%m-%d"), "hourly": ",".join(v + suffix for v in HOURLY_VARS),
                         "models": "ecmwf_ifs025", "timezone": "Europe/Madrid"})
        h.columns = [col.replace(suffix, "") for col in h.columns]
        parts.append(h)
        a = c + pd.Timedelta(days=1)
    d = _to_daily_weather(pd.concat(parts, ignore_index=True))
    cache.parent.mkdir(parents=True, exist_ok=True)
    d.to_csv(cache, index=False)
    return d


def weather_live() -> pd.DataFrame:
    """ECMWF forecast for the last days, today and tomorrow (for the live forecast)."""
    h = _get_hourly("https://api.open-meteo.com/v1/forecast",
                    {"latitude": LAT, "longitude": LON, "hourly": ",".join(HOURLY_VARS),
                     "models": "ecmwf_ifs025", "past_days": 50, "forecast_days": 2, "timezone": "Europe/Madrid"})
    return _to_daily_weather(h)
