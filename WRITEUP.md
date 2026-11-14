# AireMañana — tomorrow's air for a Madrid school

**Track:** AI + Climate · **Website:** https://julianjms-beep.github.io/aire-manana/ ·
**Code:** https://github.com/julianjms-beep/aire-manana ·
**Notebook:** [open in Colab](https://colab.research.google.com/github/julianjms-beep/aire-manana/blob/main/AireManana.ipynb)

**The problem.** Nitrogen dioxide (NO₂) comes mostly from traffic and inflames the airways; children with asthma feel it
first. From 2030 the EU allows a daily mean above 50 µg/m³ on at most 18 days a year. Air-quality apps report *today*,
but a school plans tomorrow's PE classes and recess at about 6 pm. Our question: **at 18:00, will tomorrow's NO₂ be
high, and why?**

**What we built.** A forecast for all 24 official stations in Madrid, published every evening on a bilingual website.
For each station it gives:
- tomorrow's daily mean, a likely range and the chance of exceeding 50 µg/m³
- a decision a teacher can act on ("Outdoor PE and recess are fine" / "Keep an eye on it" / "Move PE indoors")
- the reasons behind the forecast (recent levels, weekday or holiday, season, rain, wind, temperature, self-correction)

Every forecast is saved before the day happens and checked later, so the test keeps growing.

**How it works.**
- **Data:** 2.4 million official hourly NO₂ values (Ayuntamiento de Madrid, EEA), ERA5 weather, and archived ECMWF
  forecasts.
- **Honest test:** for testing we used the weather forecast that really existed the evening before.
- **Model:** the average of a ridge regression and gradient-boosted trees predicts the *change* from today to
  tomorrow. Inputs: NO₂ so far today and in recent days, tomorrow's forecast weather (rain, wind, calm hours,
  temperature, pressure) and the calendar.
- **Self-correction:** Madrid got much cleaner (267 days above the 2030 limit in 2017, 2 in 2026). Version 1 drifted,
  over-predicting by +4.4 µg/m³ in 2024 and +8.2 in 2026. Version 2 removes its own average error of the last 30 days
  every evening.
- **Splits:** train Jul 2020–Dec 2022, validation 2023–Feb 2024 (used to choose the model and the alert threshold),
  test Mar 2024–Oct 2026.

**Results (932 unseen test days, Escuelas Aguirre).**

| | Mean abs. error | Bias | Bad days caught at 30 false alarms |
|---|---|---|---|
| Baseline "tomorrow = today" | 7.97 µg/m³ | −2.1 | 13 / 45 |
| AireMañana v1 | 7.49 | +6.3 | 28 / 45 |
| **AireMañana v2** | **4.44 (−44 %)** | **−0.3** | **30 / 45** |

- Trained on one station, it beats the baseline at **all 24 stations** (17–44 % lower error); v1 was worse at 14 of
  them.
- When it said a 40–60 % chance of a bad day, one happened 44 % of the time.

**Where it fails.**
- At the alert threshold chosen in validation (45 µg/m³) it caught 30 of 45 bad days (67 %), below the 85 % reached in
  validation, because bad days became rarer.
- It misses sudden jumps on calm, dry autumn days after a clean day (26 Oct 2026: forecast 36, measured 65).
- Perfect weather would only cut the error from 4.4 to 4.2, so the weather forecast is not the main limit.
- Its 80 % range covered 75 % of days, so it is slightly too narrow.
- It covers NO₂ only, and uses central-Madrid weather for every station.
- The test was scored twice (v1, then v2). The fix was designed on validation data only.

**What we'd do next.** An automatic 6 pm e-mail or Telegram alert for a real school; ozone in summer; local weather
per station; training on all 24 stations at once.

**Sources.**
- Ayuntamiento de Madrid open data: hourly and real-time air quality, station list.
- European Environment Agency: E2a up-to-date air quality.
- Open-Meteo: ERA5, archived ECMWF IFS forecasts, live forecast.
- EU Directive 2024/2881.
- `holidays` package.
- Map: © OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
- Software: Python, pandas, scikit-learn, matplotlib, D3, MapLibre.
- AI tools: Claude Code (Anthropic, Claude Opus 5.5) helped write and debug the code and texts; Higgsfield for the
  video.

*This project is a prototype and is not medical advice.*
