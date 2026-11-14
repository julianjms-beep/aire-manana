"""AireMañana model: forecast tomorrow's mean NO2 at a Madrid station and raise an alert.

Decision time: 18:00 on day D. What is known then:
  - today's NO2 from 00:00 to 18:00 (Madrid real-time data),
  - full NO2 of previous days,
  - today's weather and the ECMWF weather forecast for tomorrow (D+1).
Target: the 24-hour mean NO2 of tomorrow (D+1), and whether it will exceed 50 µg/m³.
"""
from __future__ import annotations

import holidays
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

from madrid_data import WEATHER

LIMIT = 50.0  # µg/m³: EU daily limit value for NO2 from 2030 (Directive 2024/2881), max 18 days per year

_HOLIDAYS = holidays.country_holidays("ES", subdiv="MD", years=range(2014, 2029))


def _is_holiday(dates: pd.Series) -> pd.Series:
    return dates.dt.date.map(lambda d: d in _HOLIDAYS).astype(int)


def build_table(no2_daily: pd.DataFrame, station: int, weather_today: pd.DataFrame,
                weather_tomorrow: pd.DataFrame) -> pd.DataFrame:
    """One row per day D with everything known at 18:00 and the target (mean NO2 of D+1)."""
    s = no2_daily[no2_daily["station"] == station].set_index("date").sort_index()
    days = pd.date_range(s.index.min(), s.index.max(), freq="D")
    s = s.reindex(days)

    t = pd.DataFrame(index=days)
    t.index.name = "date"
    t["tomorrow"] = t.index + pd.Timedelta(days=1)
    t["no2_today_to_18h"] = s["mean_to_18h"]
    t["no2_yesterday"] = s["mean"].shift(1)
    t["no2_last_7_days"] = s["mean"].shift(1).rolling(7, min_periods=4).mean()
    t["no2_same_day_last_week"] = s["mean"].shift(6)     # same weekday as tomorrow
    t["target"] = s["mean"].shift(-1)                   # tomorrow's 24-hour mean NO2
    t = t.reset_index()

    tm = t["tomorrow"]
    t["weekday_tomorrow"] = tm.dt.dayofweek               # 0 = Monday ... 6 = Sunday
    t["weekday_today"] = t["date"].dt.dayofweek
    t["holiday_tomorrow"] = _is_holiday(tm)
    t["holiday_today"] = _is_holiday(t["date"])
    t["season_sin"] = np.sin(2 * np.pi * tm.dt.dayofyear / 365.25)
    t["season_cos"] = np.cos(2 * np.pi * tm.dt.dayofyear / 365.25)

    wt = weather_today.rename(columns={c: c + "_today" for c in WEATHER})
    wm = weather_tomorrow.rename(columns={c: c + "_tomorrow" for c in WEATHER}).rename(columns={"date": "tomorrow"})
    t = t.merge(wt[["date"] + [c + "_today" for c in WEATHER]], on="date", how="left")
    t = t.merge(wm[["tomorrow"] + [c + "_tomorrow" for c in WEATHER]], on="tomorrow", how="left")
    t["pressure_change"] = t["pressure_tomorrow"] - t["pressure_today"]
    t["station"] = station
    return t


FEATURES = (["no2_today_to_18h", "no2_yesterday", "no2_last_7_days", "no2_same_day_last_week",
             "weekday_tomorrow", "weekday_today", "holiday_tomorrow", "holiday_today", "season_sin", "season_cos"]
            + [c + "_tomorrow" for c in WEATHER]
            + ["rain_today", "wind_mean_today", "calm_hours_today", "pressure_change"])

# Groups used to explain a forecast in plain words.
GROUPS = {
    "NO2 of the last days": ["no2_today_to_18h", "no2_yesterday", "no2_last_7_days", "no2_same_day_last_week"],
    "Day of the week / holiday": ["holiday_tomorrow", "holiday_today"] + [f"dow_tomorrow_{d}" for d in range(7)]
                                 + [f"dow_today_{d}" for d in range(7)],
    "Season": ["season_sin", "season_cos"],
    "Rain": ["rain_tomorrow", "rain_today", "humidity_tomorrow", "clouds_tomorrow"],
    "Wind": ["wind_mean_tomorrow", "wind_max_tomorrow", "wind_u_tomorrow", "wind_v_tomorrow",
             "calm_hours_tomorrow", "wind_mean_today", "calm_hours_today"],
    "Temperature & pressure": ["temp_mean_tomorrow", "temp_max_tomorrow", "temp_min_tomorrow",
                               "temp_range_tomorrow", "pressure_tomorrow", "pressure_change"],
}


# ------------------------------------------------------------------ simple baselines
def baseline_persistence(t: pd.DataFrame) -> np.ndarray:
    """'Tomorrow will be like today' (today's mean so far, 00:00-18:00)."""
    return t["no2_today_to_18h"].to_numpy()


def baseline_yesterday(t: pd.DataFrame) -> np.ndarray:
    """'Tomorrow will be like the last full day I know' (yesterday)."""
    return t["no2_yesterday"].to_numpy()


def baseline_weekday_rule(train: pd.DataFrame, t: pd.DataFrame) -> np.ndarray:
    """Today's level times the usual change for this pair of weekdays (e.g. Saturday -> Sunday)."""
    ratio = (train["target"] / train["no2_today_to_18h"]).groupby(
        [train["weekday_today"], train["weekday_tomorrow"]]).median()
    f = [ratio.get((a, b), 1.0) for a, b in zip(t["weekday_today"], t["weekday_tomorrow"])]
    return t["no2_today_to_18h"].to_numpy() * np.array(f)


# ------------------------------------------------------------------ models
class _Base:
    """Both models learn the CHANGE from today to tomorrow on a log scale (log(tomorrow) - log(today)),
    not the absolute level. Madrid's NO2 halved between 2015 and 2025, so the absolute level the model
    saw in training would be out of date; the change caused by weather and weekdays is much more stable.
    Set relative=False to train on the absolute level instead (used to show that problem)."""

    def __init__(self, relative: bool = True):
        self.relative = relative

    def _ref(self, t):
        return np.log1p(t["no2_today_to_18h"].to_numpy())

    def _y(self, t):
        y = np.log1p(t["target"].to_numpy())
        return y - self._ref(t) if self.relative else y

    def _out(self, t, p):
        return np.expm1(p + self._ref(t) if self.relative else p)


class LinearModel(_Base):
    """Ridge regression on standardised features (weekdays as one-hot columns)."""

    def _x(self, t: pd.DataFrame) -> pd.DataFrame:
        x = t[FEATURES].copy()
        for d in range(7):
            x[f"dow_tomorrow_{d}"] = (t["weekday_tomorrow"] == d).astype(int)
            x[f"dow_today_{d}"] = (t["weekday_today"] == d).astype(int)
        return x.drop(columns=["weekday_tomorrow", "weekday_today"])

    def fit(self, t):
        x = self._x(t)
        self.medians = x.median()
        x = x.fillna(self.medians)
        self.scaler = StandardScaler().fit(x)
        self.ridge = RidgeCV(alphas=np.logspace(-2, 3, 20)).fit(self.scaler.transform(x), self._y(t))
        self.columns = list(x.columns)
        return self

    def predict(self, t):
        x = self._x(t).fillna(self.medians)
        return self._out(t, self.ridge.predict(self.scaler.transform(x)))

    def contributions(self, t: pd.DataFrame) -> pd.DataFrame:
        """How much each group of inputs pushes tomorrow's NO2 up or down, compared with an average day
        (as a % change). Only meaningful for the relative model."""
        x = self._x(t).fillna(self.medians)
        z = self.scaler.transform(x) * self.ridge.coef_
        z = pd.DataFrame(z, columns=self.columns, index=t.index)
        out = pd.DataFrame({g: z[[c for c in cols if c in z.columns]].sum(axis=1) for g, cols in GROUPS.items()})
        return (np.exp(out) - 1) * 100


class TreeModel(_Base):
    """Gradient-boosted decision trees: can learn interactions (e.g. calm wind AND a cold winter night)."""

    def fit(self, t):
        self.m = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, max_leaf_nodes=31,
                                               min_samples_leaf=40, l2_regularization=1.0, random_state=0)
        self.m.fit(t[FEATURES], self._y(t))
        return self

    def predict(self, t):
        return self._out(t, self.m.predict(t[FEATURES]))


CORRECTION_DAYS = 30


class AireManana:
    """Final model: average of the linear model and the tree model (chosen on 2023 validation data).

    predict()  -> raw forecast (version 1).
    forecast() -> raw forecast corrected by the model's own average error over the last 30 days that are
                  already known at 18:00 (version 2). Madrid keeps getting cleaner, so a model trained on past
                  years slowly drifts; this running bias correction lets it adapt without re-training.
    """

    def __init__(self, relative: bool = True):
        self.linear, self.trees = LinearModel(relative), TreeModel(relative)

    def fit(self, t):
        self.linear.fit(t)
        self.trees.fit(t)
        return self

    def predict(self, t):
        return 0.5 * self.linear.predict(t) + 0.5 * self.trees.predict(t)

    def forecast(self, t: pd.DataFrame, days: int = CORRECTION_DAYS) -> np.ndarray:
        """`t` must be one station's rows in date order, with `target` where it is already known.
        For day D, the last error we can know at 18:00 is the one for row D-2 (its target, the mean of D-1,
        ended at midnight); row D-1's target is today, still unfinished. So we use rows D-2-days+1 ... D-2."""
        raw = self.predict(t)
        err = pd.Series(np.log1p(raw) - np.log1p(t["target"].to_numpy()), index=pd.DatetimeIndex(t["date"]))
        err = err.reindex(pd.date_range(err.index.min(), err.index.max(), freq="D"))
        correction = err.shift(2).rolling(days, min_periods=10).mean()
        return np.expm1(np.log1p(raw) - correction.reindex(t["date"]).fillna(0).to_numpy())

    def explain(self, t):
        return self.linear.contributions(t)


# ------------------------------------------------------------------ evaluation
def scores(actual, predicted, limit: float = LIMIT, alert_at: float | None = None) -> dict:
    """Mean absolute error, and for the alert: bad days caught, missed, and false alarms."""
    alert_at = limit if alert_at is None else alert_at
    actual, predicted = np.asarray(actual, float), np.asarray(predicted, float)
    ok = ~np.isnan(actual) & ~np.isnan(predicted)
    actual, predicted = actual[ok], predicted[ok]
    bad, alert = actual > limit, predicted > alert_at
    return {
        "days": int(ok.sum()),
        "mean_abs_error": round(float(np.mean(np.abs(actual - predicted))), 2),
        "bad_days": int(bad.sum()),
        "caught": int((bad & alert).sum()),
        "missed": int((bad & ~alert).sum()),
        "false_alarms": int((~bad & alert).sum()),
        "recall": round(float((bad & alert).sum() / max(bad.sum(), 1)), 3),
        "precision": round(float((bad & alert).sum() / max(alert.sum(), 1)), 3),
    }
