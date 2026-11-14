# AireMañana — tomorrow's air for a Madrid school

**Track:** AI + Climate · **Team:** see the submission form

**Live website:** https://julianjms-beep.github.io/aire-manana/ (English / Español, updated every evening)
**Notebook (runs end to end in Colab):** [AireManana.ipynb](https://colab.research.google.com/github/julianjms-beep/aire-manana/blob/main/AireManana.ipynb)

> This project is a prototype and is not medical advice.

## The problem

Nitrogen dioxide (NO₂) comes mostly from traffic. It inflames the airways, and children with asthma feel it first.
From 2030 the EU allows a daily mean above 50 µg/m³ on at most 18 days a year (Directive 2024/2881).

Air-quality apps tell you about **today**. A school needs to know about **tomorrow**, and it needs to know at about 6 pm,
when it plans the next day's PE classes and recess. AireMañana answers exactly that question for every official
station in Madrid, with a reason a teacher can read.

## What we built

- **A forecast model.** At 18:00 it predicts tomorrow's daily mean NO₂ from the official measurements so far, the
  weather forecast for tomorrow and the calendar.
- **A self-correction.** Madrid's air has improved so much since 2015 that a model trained on the past keeps expecting
  pollution that no longer comes. Version 2 measures its own average error over the last 30 days every evening and
  removes it.
- **A live website** that runs every evening for all 24 stations. It shows:
  - the forecast, a likely range and the chance of going over the EU limit
  - a simple decision ("Outdoor PE and recess are fine" / "Keep an eye on it" / "Move PE indoors")
  - the reasons behind the forecast
  - a map of the whole city
- **A growing, truly unseen test.** Every forecast is saved before the day happens and checked once it has been
  measured (`web/data/log.csv`).

## How it works (data and model)

| | |
|---|---|
| NO₂ | 2,436,010 official hourly values from the 24 stations of Madrid, 2015 → today (Ayuntamiento de Madrid; recent days from the EEA) |
| Weather | ERA5 for history; for testing, **the ECMWF forecast that was really available the evening before** (not the weather that happened); the live ECMWF forecast for tomorrow |
| Calendar | weekday, Madrid public holidays, season |
| Target | tomorrow's daily mean, predicted as the change from today (log scale), so the model learns how weather and weekdays *move* pollution, which stays stable while the city gets cleaner |
| Model | average of a ridge regression and gradient-boosted trees (scikit-learn), plus the 30-day self-correction |
| Splits | train Jul 2020 – Dec 2022 · validation 2023 – Feb 2024 (choose model and alert threshold) · **test Mar 2024 – Oct 2026 (932 days, never used to choose anything)** · live from Nov 2026 |
| Alert | alert when the forecast is above 45 µg/m³, the highest threshold that still caught ≥ 85 % of bad days in validation |
| Uncertainty | likely range (10th–90th percentile) and P(> 50 µg/m³) from the validation errors |

The model is trained on one station (Escuelas Aguirre, urban traffic) and then run on all 24.

## Results (held-out test, 932 days, Escuelas Aguirre)

| Method | Mean absolute error (µg/m³) | Bias | Bad days caught (of 45) | False alarms |
|---|---|---|---|---|
| Baseline: "tomorrow = today" | 7.97 | −2.1 | 38 | 223 |
| Weekday rule | 7.82 | +0.9 | 34 | 153 |
| AireMañana v1 (no self-correction) | 7.49 | +6.3 | 36 | 58 |
| **AireMañana v2** | **4.44** | **−0.3** | 30 | **30** |

Each method uses its own alert threshold, chosen on validation.

- **44 % lower error than the baseline** (4.4 vs 8.0 µg/m³).
- **Same number of false alarms, more than twice the bad days caught.** With 30 false alarms in the test period, v2
  catches 30 of 45 bad days and "tomorrow = today" catches 13. With 60 false alarms: 39 vs 18.
- **It beats the baseline at all 24 stations** (17–44 % lower error), although it was trained on only one of them.
  Version 1 was *worse* than the baseline at 14 of them, mostly the clean ones. The self-correction fixed that.
- **The drift we found.** v1 over-predicted more every year (+4.4 µg/m³ in 2024, +8.2 in 2026). Neither training on
  more years nor predicting the level instead of the change fixed it. The 30-day self-correction did: bias −0.3,
  error 7.5 → 4.4.
- **Uncertainty.** When the model gave a 40–60 % chance of a bad day, it happened 44 % of the time. The 80 % likely range
  contained the true value on 75 % of test days, so it is a bit too narrow.

### Where it fails

- At the threshold chosen on validation it caught 30 of 45 bad days in the test (67 %), below the 85 % it reached in
  validation, because bad days became rarer. The trade-off curve on the website shows every threshold.
- It misses sudden jumps on calm, dry autumn days that follow a clean day (e.g. 26 Oct 2026: forecast 36, measured 65).
- The weather forecast is not the main problem. With the weather that really happened, the error would only fall from
  4.4 to 4.2.
- It only covers NO₂, not ozone or particles. Central Madrid's weather is used for every station.
- The test period was scored twice: once for v1, and again for v2 after we found the drift. The fix was designed on
  validation data only.

## What we'd do next

- An automatic 6 pm e-mail or Telegram alert for a real school.
- Ozone in summer, and local weather for every station.
- Train on all 24 stations at once, so each one learns from the others.

## Run it

```bash
pip install -r requirements.txt
jupyter notebook AireManana.ipynb            # the full study: data, baselines, model, test, drift, stations
python make_site_data.py evaluate            # test-period results  -> web/data/evaluation.json
python make_site_data.py live                # tomorrow's forecast  -> web/data/forecast.json
cd web && python -m http.server              # the website
```

A GitHub Action (`.github/workflows/daily.yml`) runs `make_site_data.py live` every evening and publishes `web/` to
GitHub Pages.

| File | What it does |
|---|---|
| `madrid_data.py` | downloads and cleans the NO₂ data (history, real time, EEA) and the weather (ERA5, archived and live ECMWF forecasts) |
| `forecast_model.py` | features, the model (ridge + boosted trees + self-correction), baselines and scores |
| `live.py` | tomorrow's forecast for one station, with range, probability and reasons |
| `make_site_data.py` | builds the website data |
| `web/` | the website (HTML, CSS, D3, MapLibre) |

## Sources

**Data**
- Ayuntamiento de Madrid, open data: hourly air quality (dataset 201200), real-time air quality (212531),
  station list (212629). https://datos.madrid.es
- European Environment Agency: up-to-date air quality data (E2a). https://eeadmz1-downloads-webapp.azurewebsites.net/
- Open-Meteo: ERA5 historical weather, archived ECMWF IFS forecasts (Previous Runs API), live forecast. https://open-meteo.com
- EU Directive 2024/2881 on ambient air quality: NO₂ daily limit of 50 µg/m³, at most 18 days a year from 2030
  ([EEA summary](https://www.eea.europa.eu/en/analysis/publications/air-quality-status-report-2025/benchmark-analysis-against-the-standards-in-the-revised-directive-eu-2024-2881)).
- Madrid public holidays: the `holidays` Python package.
- Map: © OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors.

**Software:** Python, pandas, NumPy, scikit-learn, matplotlib, D3, MapLibre GL.

**AI tools**
- Claude Code (Anthropic, Claude Opus 5.5) helped write and debug the code and texts.
- Higgsfield was used for the explanation video.
