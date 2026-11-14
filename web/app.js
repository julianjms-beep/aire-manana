/* AireMañana — front end. Reads data/forecast.json (updated every evening) and data/evaluation.json (test results). */
(() => {
  "use strict";
  const REPO = "https://github.com/julianjms-beep/aire-manana";
  const COLAB = "https://colab.research.google.com/github/julianjms-beep/aire-manana/blob/main/AireManana.ipynb";
  const MAIN = 8;                                   // Escuelas Aguirre
  const $ = (s, el = document) => el.querySelector(s);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let lang = new URLSearchParams(location.search).get("lang") || store.get("lang")
    || ((navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en");
  if (!I18N[lang]) lang = "en";
  let F = null, E = null, sel = MAIN, map = null, markers = {};

  // ------------------------------------------------------------------ helpers
  const t = (key, vars = {}) => String((I18N[lang] || {})[key] ?? I18N.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  const loc = () => (lang === "es" ? "es-ES" : "en-GB");
  const fmt = (v, d = 0) => (v == null || Number.isNaN(+v) ? "–" : Number(v).toLocaleString(loc(), { maximumFractionDigits: d, minimumFractionDigits: d }));
  const day = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const dname = (s, o) => day(s).toLocaleDateString(loc(), o);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const TYPES = { es: { "Urban traffic": "Urbana de tráfico", "Urban background": "Urbana de fondo", "Suburban": "Suburbana" } };
  const typeName = x => (lang === "es" && TYPES.es[x]) || x || "";
  const no2Color = d3.scaleLinear().domain([0, 15, 25, 35, 45, 55, 80])
    .range(["#0E9F6E", "#3BB273", "#9CC23B", "#E2B32A", "#EE7A31", "#DE3D33", "#A61E3A"]).clamp(true);
  const BAND_VALUES = [12, 32, 45, 62];
  const level = s => (s.alert ? "alert" : s.forecast >= 35 ? "watch" : "ok");
  const station = id => F.stations.find(s => s.id === id);

  const tip = $("#tip");
  function showTip(html, ev) { tip.innerHTML = html; tip.classList.add("on"); moveTip(ev); }
  function moveTip(ev) {
    const p = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + p, y = ev.clientY + p;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - p;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - p;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  const hideTip = () => tip.classList.remove("on");

  function svgIn(el, w, h) {
    d3.select(el).selectAll("*").remove();
    return d3.select(el).append("svg").attr("width", w).attr("height", h).attr("viewBox", `0 0 ${w} ${h}`);
  }
  function legend(el, items) {
    el.innerHTML = items.map(([label, color, kind = ""]) =>
      `<span><i class="${kind}" style="background:${color};border-color:${color};color:${color}"></i>${esc(label)}</span>`).join("");
  }
  function countTo(el, to) {
    const from = Number(el.dataset.v || 0); el.dataset.v = to;
    if (reduced) { el.textContent = Math.round(to); return; }
    const t0 = performance.now(), dur = 900;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ static texts
  function applyStatic() {
    document.documentElement.lang = lang;
    document.title = t("doc.title");
    document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll(".lang button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    $("#notebookLink").href = COLAB; $("#colabLink").href = COLAB; $("#repoLink").href = REPO;
  }

  // ------------------------------------------------------------------ 1 · hero
  function renderHero() {
    const s = station(sel);
    const ok = s && s.status === "ok";
    const lv = ok ? level(s) : "ok";
    $("#forecast").style.setProperty("--tint", ok ? `var(--${lv === "alert" ? "bad" : lv === "watch" ? "mod" : "good"})` : "var(--faint)");
    $("#heroDay").textContent = t("hero.for", { day: dname(F.tomorrow, { weekday: "long", day: "numeric", month: "long" }) });
    renderPicker(s);
    $("#stationMeta").textContent = [typeName(s.type), s.address].filter(Boolean).join(" · ");

    const v = $("#verdict");
    v.className = `verdict ${ok ? lv : ""}`;
    if (!ok) {
      $("#bigNum").textContent = "–"; $("#bigNum").dataset.v = 0;
      $("#verdictTitle").textContent = t("map.nodata"); $("#verdictSub").textContent = t("nodata");
      ["#statChance", "#statRange", "#statToday"].forEach(id => { $(id).textContent = "–"; });
      $("#statTodayNote").textContent = ""; $("#scale").innerHTML = ""; $("#why").innerHTML = "";
      d3.select("#histChart").selectAll("*").remove();
      return;
    }
    countTo($("#bigNum"), s.forecast);
    $("#verdictTitle").textContent = t(`verdict.${lv}`);
    $("#verdictSub").textContent = t(`verdict.${lv}.sub`);
    $("#statChance").innerHTML = s.p_exceed < 0.01 ? "&lt;1<small>%</small>" : `${fmt(s.p_exceed * 100)}<small>%</small>`;
    $("#statRange").innerHTML = `${fmt(s.low)}–${fmt(s.high)}<small>µg/m³</small>`;
    $("#statToday").innerHTML = `${fmt(s.today_so_far)}<small>µg/m³</small>`;
    $("#statTodayNote").textContent = t("stat.today.note", { h: s.hours_today });
    renderScale(s);
    renderHistory(s);
    renderWhy(s);
  }

  // Station picker: a styled listbox (a native <select> would open its menu at the 52 px heading size).
  const pick = { btn: $("#pickBtn"), pop: $("#pickPop"), list: $("#pickList"), ids: [], active: -1, typed: "", typedAt: 0 };
  const fold = x => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  function renderPicker(s) {
    $("#pickName").textContent = s.name;
    const rows = [...F.stations].sort((a, b) => a.name.localeCompare(b.name, "es"));
    pick.ids = rows.map(x => x.id);
    pick.list.innerHTML = rows.map(x => {
      const ok = x.status === "ok";
      return `<li role="option" id="pick-${x.id}" data-id="${x.id}" aria-selected="${x.id === sel}" class="${ok ? "" : "off"}">
        <i style="background:${ok ? no2Color(x.forecast) : "var(--line-2)"}"></i>
        <span>${esc(x.name)}<small>${esc(typeName(x.type))}</small></span><b>${ok ? fmt(x.forecast) : "–"}</b></li>`;
    }).join("");
    if (!pick.pop.hidden) setActive(pick.ids.indexOf(sel));
  }
  function setActive(i, scroll = true) {
    const items = pick.list.children;
    if (!items.length) return;
    i = Math.max(0, Math.min(items.length - 1, i));
    if (items[pick.active]) items[pick.active].classList.remove("active");
    pick.active = i;
    items[i].classList.add("active");
    pick.list.setAttribute("aria-activedescendant", items[i].id);
    const li = items[i], l = pick.list;
    if (!scroll) return;
    if (li.offsetTop < l.scrollTop) l.scrollTop = li.offsetTop - 6;
    else if (li.offsetTop + li.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = li.offsetTop + li.offsetHeight - l.clientHeight + 6;
  }
  function openPicker() {
    if (!F || !pick.pop.hidden) return;
    pick.pop.hidden = false; pick.btn.setAttribute("aria-expanded", "true");
    const i = pick.ids.indexOf(sel);
    pick.list.scrollTop = 0; setActive(i);
    const li = pick.list.children[i];
    if (li) pick.list.scrollTop = Math.max(0, li.offsetTop - pick.list.clientHeight / 2 + li.offsetHeight / 2);
    pick.list.focus({ preventScroll: true });
  }
  function closePicker(refocus) {
    if (pick.pop.hidden) return;
    pick.pop.hidden = true; pick.btn.setAttribute("aria-expanded", "false");
    if (refocus) pick.btn.focus({ preventScroll: true });
  }
  function choose(i) {
    const id = pick.ids[i];
    closePicker(true);
    if (id != null && id !== sel) select(id);
  }
  pick.btn.addEventListener("click", () => (pick.pop.hidden ? openPicker() : closePicker(false)));
  pick.btn.addEventListener("keydown", ev => {
    if (["ArrowDown", "ArrowUp"].includes(ev.key)) { ev.preventDefault(); openPicker(); }
  });
  pick.list.addEventListener("keydown", ev => {
    const n = pick.ids.length, k = ev.key;
    if (k === "ArrowDown") setActive(pick.active + 1);
    else if (k === "ArrowUp") setActive(pick.active - 1);
    else if (k === "Home") setActive(0);
    else if (k === "End") setActive(n - 1);
    else if (k === "PageDown") setActive(pick.active + 8);
    else if (k === "PageUp") setActive(pick.active - 8);
    else if (k === "Enter" || k === " ") choose(pick.active);
    else if (k === "Escape") closePicker(true);
    else if (k === "Tab") { closePicker(false); return; }
    else if (k.length === 1 && /\S/.test(k)) {
      const now = Date.now();
      pick.typed = (now - pick.typedAt > 700 ? "" : pick.typed) + fold(k); pick.typedAt = now;
      const names = pick.ids.map(id => fold(station(id).name));
      const from = pick.typed.length === 1 ? pick.active + 1 : pick.active;
      for (let j = 0; j < n; j++) { const q = (from + j) % n; if (names[q].startsWith(pick.typed)) { setActive(q); break; } }
    } else return;
    ev.preventDefault();
  });
  let lastPt = "";
  pick.list.addEventListener("pointermove", ev => {
    const pt = `${ev.clientX},${ev.clientY}`;                       // Safari also fires this when the list scrolls under a still mouse
    if (pt === lastPt) return;
    lastPt = pt;
    const li = ev.target.closest("li");
    if (li) setActive([...pick.list.children].indexOf(li), false);
  });
  pick.list.addEventListener("click", ev => {
    const li = ev.target.closest("li");
    if (li) choose([...pick.list.children].indexOf(li));
  });
  document.addEventListener("pointerdown", ev => { if (!$("#stationPick").contains(ev.target)) closePicker(false); });

  function renderScale(s) {
    const max = Math.max(80, Math.ceil((s.high * 1.1) / 10) * 10);
    const pct = v => `${(Math.min(v, max) / max) * 100}%`;
    const ticks = d3.range(0, max + 1, max > 80 ? 25 : 20).filter(v => Math.abs(v - F.limit) > 6 && Math.abs(v - F.alert_at) > 6);
    $("#scale").innerHTML = `
      <div class="scale-track"></div>
      <div class="scale-line" style="left:${pct(F.alert_at)}"></div>
      <div class="scale-line" style="left:${pct(F.limit)}"></div>
      <div class="scale-flag left" style="left:${pct(F.alert_at)}">${t("scale.alert")} ${fmt(F.alert_at)}</div>
      <div class="scale-flag right" style="left:${pct(F.limit)}">${t("scale.limit")} ${fmt(F.limit)}</div>
      <div class="scale-range" style="left:${pct(s.low)};width:calc(${pct(s.high)} - ${pct(s.low)})"></div>
      <div class="scale-marker" style="left:0"></div>
      ${ticks.map(v => `<div class="scale-tick" style="left:${pct(v)}">${v}</div>`).join("")}`;
    requestAnimationFrame(() => { $("#scale .scale-marker").style.left = pct(s.forecast); });
  }

  function renderHistory(s) {
    const el = $("#histChart"), W = el.clientWidth, H = 210, m = { t: 14, r: 6, b: 26, l: 30 };
    const rows = s.history.map(([d, v]) => ({ d, v, kind: "h" }));
    rows.push({ d: F.today, v: s.today_so_far, kind: "today" }, { d: F.tomorrow, v: s.forecast, kind: "fc" });
    const x = d3.scaleBand().domain(rows.map(r => r.d)).range([m.l, W - m.r]).padding(0.22);
    const ymax = Math.max(60, d3.max(rows, r => r.v) * 1.15, s.high * 1.05);
    const y = d3.scaleLinear().domain([0, ymax]).nice().range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    const defs = svg.append("defs");
    defs.append("pattern").attr("id", "hatch").attr("width", 5).attr("height", 5).attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(45)").append("rect").attr("width", 2).attr("height", 5).attr("fill", css("--persist"));
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6));
    const lastIdx = rows.length - 1;
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(8)
        .tickValues(rows.filter((r, i) => i === lastIdx || (lastIdx - i) % 7 === 0 && i < lastIdx - 2 && x(r.d) - m.l > 18).map(r => r.d))
        .tickFormat(d => (d === F.tomorrow ? dname(d, { weekday: "short" }) : dname(d, { day: "numeric", month: "short" }))));
    svg.append("line").attr("class", "limit-line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(F.limit)).attr("y2", y(F.limit));
    svg.append("text").attr("class", "lbl-m").attr("x", m.l + 4).attr("y", y(F.limit) - 5).text(`${t("scale.limit")} ${F.limit}`);
    const bars = svg.append("g").selectAll("rect").data(rows).join("rect")
      .attr("x", r => x(r.d)).attr("width", x.bandwidth()).attr("rx", Math.min(4, x.bandwidth() / 3))
      .attr("y", y(0)).attr("height", 0)
      .attr("fill", r => (r.kind === "fc" ? no2Color(r.v) : r.kind === "today" ? "url(#hatch)" : css("--persist")))
      .attr("opacity", r => (r.kind === "h" ? 0.55 : 1))
      .attr("stroke", r => (r.kind === "today" ? css("--persist") : "none"));
    bars.transition().duration(reduced ? 0 : 700).delay((r, i) => (reduced ? 0 : i * 14)).ease(d3.easeCubicOut)
      .attr("y", r => y(r.v ?? 0)).attr("height", r => y(0) - y(r.v ?? 0));
    const cx = x(F.tomorrow) + x.bandwidth() / 2;
    svg.append("line").attr("x1", cx).attr("x2", cx).attr("y1", y(s.low)).attr("y2", y(s.high)).attr("stroke", css("--ink")).attr("stroke-width", 1.5);
    [s.low, s.high].forEach(v => svg.append("line").attr("x1", cx - 5).attr("x2", cx + 5).attr("y1", y(v)).attr("y2", y(v)).attr("stroke", css("--ink")).attr("stroke-width", 1.5));
    svg.append("text").attr("class", "lbl").attr("x", cx).attr("y", y(Math.max(s.high, s.forecast)) - 8).attr("text-anchor", "end")
      .attr("dx", x.bandwidth() / 2).text(fmt(s.forecast));
    svg.append("g").selectAll("rect").data(rows).join("rect").attr("x", r => x(r.d) - 2).attr("width", x.bandwidth() + 4)
      .attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "transparent")
      .on("pointermove", (ev, r) => showTip(`<b>${cap(dname(r.d, { weekday: "long", day: "numeric", month: "long" }))}</b><br>${
        r.kind === "fc" ? `${t("hist.forecast")}: ${fmt(r.v)} µg/m³ (${fmt(s.low)}–${fmt(s.high)})` : r.kind === "today"
          ? `${t("hist.today")}: ${fmt(r.v)} µg/m³` : `${t("hist.measured")}: ${fmt(r.v, 1)} µg/m³`}`, ev))
      .on("pointerleave", hideTip);
    legend($("#histLegend"), [[t("hist.measured"), css("--persist")], [t("hist.today"), css("--persist"), "hatch"], [t("hist.forecast"), no2Color(s.forecast)]]);
  }

  function whyText(w, s) {
    const up = w.pct > 0, W = F.weather_tomorrow;
    switch (w.key) {
      case "recent":
        if (up && s.today_so_far < s.last_7_days) return t("why.recent.up.low", { t: fmt(s.today_so_far), w: fmt(s.last_7_days) });
        if (!up && s.today_so_far > s.last_7_days) return t("why.recent.down.high", { t: fmt(s.today_so_far), w: fmt(s.last_7_days) });
        return t(up ? "why.recent.up" : "why.recent.down");
      case "correction": return t(up ? "why.correction.up" : "why.correction.down");
      case "weekday":
        if (F.holiday_tomorrow && !up) return t("why.weekday.holiday");
        return t(up ? "why.weekday.up" : "why.weekday.down", { day: cap(dname(F.tomorrow, { weekday: "long" })) });
      case "season": return t(up ? "why.season.up" : "why.season.down", { month: dname(F.tomorrow, { month: "long" }) });
      case "rain": return up ? t("why.rain.up") : W.rain >= 0.5 ? t("why.rain.down", { rain: fmt(W.rain, 1) }) : t("why.rain.down.dry");
      case "wind": return up ? t("why.wind.up", { calm: fmt(W.calm_hours) }) : t("why.wind.down", { wind: fmt(W.wind) });
      case "temp": return up ? t("why.temp.up", { tmin: fmt(W.temp_min), tmax: fmt(W.temp_max) }) : t("why.temp.down");
      default: return w.key;
    }
  }

  function renderWhy(s) {
    const items = s.why.filter(w => Math.abs(w.pct) >= 1);
    const max = Math.max(25, d3.max(items, w => Math.abs(w.pct)));
    $("#why").innerHTML = items.map(w => {
      const up = w.pct > 0, width = (Math.abs(w.pct) / max) * 50;
      return `<li class="${up ? "up" : "down"}"><span>${esc(whyText(w, s))}</span>
        <span class="why-bar"><b data-w="${width}" style="${up ? "left:50%" : "right:50%"};width:0;background:var(--${up ? "bad" : "good"})"></b></span>
        <span class="why-pct">${up ? "+" : "−"}${fmt(Math.abs(w.pct))}%</span></li>`;
    }).join("");
    requestAnimationFrame(() => document.querySelectorAll("#why b").forEach(b => { b.style.width = `${b.dataset.w}%`; }));
  }

  const ICONS = {
    rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 15.5a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 8a3.75 3.75 0 0 1 .5 7.47"/><path d="M9 18l-1 2M13 17l-1.2 3M17 18l-1 2"/></svg>',
    wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h7"/></svg>',
    temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/></svg>',
    calm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>',
  };
  function renderWeather() {
    const W = F.weather_tomorrow;
    const items = [["rain", `${fmt(W.rain, 1)} mm`, "wx.rain"], ["wind", `${fmt(W.wind)} km/h`, "wx.wind"],
      ["temp", `${fmt(W.temp_min)}–${fmt(W.temp_max)} °C`, "wx.temp"], ["calm", `${fmt(W.calm_hours)} h`, "wx.calm"]];
    $("#wx").innerHTML = items.map(([k, v, l]) => `<div class="wx-item">${ICONS[k]}<div><div class="wx-v">${v}</div><div class="wx-l">${t(l)}</div></div></div>`).join("");
    const issued = new Date(F.issued);
    const time = issued.toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
    const hour = Number(issued.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Madrid" }));
    const main = station(MAIN);
    $("#issued").textContent = hour < 18
      ? t("issued.early", { time, h: main && main.hours_today ? main.hours_today : "–" })
      : t("issued", { date: dname(F.today, { weekday: "long", day: "numeric", month: "long" }), time });
  }

  // ------------------------------------------------------------------ 2 · map
  function pinHtml(s) {
    const ok = s.status === "ok";
    return `<div class="pin ${ok ? "" : "nodata"} ${s.id === sel ? "sel" : ""}" style="--c:${ok ? no2Color(s.forecast) : "#B8BDC4"}">${ok ? Math.round(s.forecast) : "–"}</div>`;
  }
  function popupHtml(s) {
    if (s.status !== "ok") return `<div class="pop"><div class="pop-name">${esc(s.name)}</div><div class="pop-meta">${t("nodata")}</div></div>`;
    const lv = level(s);
    return `<div class="pop"><div class="pop-name">${esc(s.name)}</div>
      <div class="pop-row"><span class="pop-num">${fmt(s.forecast)}</span><span class="pop-unit">µg/m³</span></div>
      <div class="pop-verdict ${lv}"><i></i>${t(`verdict.${lv}`)}</div>
      <div class="pop-meta">${t("stat.range")} ${fmt(s.low)}–${fmt(s.high)} · ${t("stat.chance")} ${s.p_exceed < 0.01 ? "&lt;1" : fmt(s.p_exceed * 100)}%</div>
      <button class="pop-btn" type="button" data-go="${s.id}">${t("map.open")} ↑</button></div>`;
  }
  function closePopups(except) {
    Object.values(markers).forEach(mk => { const p = mk.getPopup(); if (p && p !== except && p.isOpen()) p.remove(); });
  }
  function renderMap() {
    const pts = F.stations.filter(s => s.lat);
    if (!map) {
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      const lons = pts.map(s => s.lon), lats = pts.map(s => s.lat);
      map = new maplibregl.Map({
        container: "mapgl", style: `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`,
        bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        fitBoundsOptions: { padding: { top: 50, bottom: 70, left: 66, right: 50 } },
        dragRotate: false, pitchWithRotate: false, attributionControl: false,
      });
      map.scrollZoom.disable();
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
      map.once("idle", () => document.querySelectorAll("#mapgl .maplibregl-ctrl-attrib").forEach(e => { e.classList.remove("maplibregl-compact-show"); e.removeAttribute("open"); }));
      $("#mapgl").addEventListener("click", ev => {
        const b = ev.target.closest("[data-go]");
        if (b) { select(Number(b.dataset.go)); $("#forecast").scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); }
      });
    }
    Object.values(markers).forEach(mk => mk.remove()); markers = {};
    pts.forEach(s => {
      const el = document.createElement("div");
      el.className = "pin-wrap"; el.innerHTML = pinHtml(s); el.title = s.name;
      const popup = new maplibregl.Popup({ closeButton: false, offset: 22, className: "pop-wrap", maxWidth: "270px" }).setHTML(popupHtml(s));
      const mk = new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).setPopup(popup).addTo(map);
      el.addEventListener("click", () => { closePopups(popup); sel = s.id; renderHero(); refreshMapSelection(); });
      markers[s.id] = mk;
    });
    $("#mapLegend").innerHTML = [1, 2, 3, 4].map(b => `<span><i style="background:${no2Color(BAND_VALUES[b - 1])}"></i>${t(`band.${b}`)}</span>`).join("");
    renderRank();
    refreshMapSelection();
  }
  function refreshMapSelection() {
    F.stations.forEach(s => {
      const mk = markers[s.id]; if (!mk) return;
      const wrap = mk.getElement(), pin = wrap.querySelector(".pin");
      if (pin) pin.classList.toggle("sel", s.id === sel);
      wrap.style.zIndex = s.id === sel ? 3 : s.status === "ok" ? 2 : 1;
    });
    document.querySelectorAll(".rank-row").forEach(r => r.classList.toggle("sel", Number(r.dataset.id) === sel));
  }
  function renderRank() {
    const list = [...F.stations].sort((a, b) => (b.forecast ?? -1) - (a.forecast ?? -1));
    const max = Math.max(50, d3.max(list, s => s.forecast || 0));
    $("#rank").innerHTML = list.map((s, i) => `<li class="rank-row${s.id === sel ? " sel" : ""}" data-id="${s.id}" tabindex="0">
      <span class="rank-n">${String(i + 1).padStart(2, "0")}</span><span class="rank-name">${esc(s.name)}</span>
      <span class="rank-bar"><b style="width:${s.status === "ok" ? (s.forecast / max) * 100 : 0}%;background:${s.status === "ok" ? no2Color(s.forecast) : "transparent"}"></b></span>
      <span class="rank-v">${s.status === "ok" ? fmt(s.forecast) : "–"}</span></li>`).join("");
    document.querySelectorAll(".rank-row").forEach(r => {
      const go = () => {
        const id = Number(r.dataset.id); select(id);
        const mk = markers[id]; if (!mk) return;
        closePopups(mk.getPopup()); map.easeTo({ center: mk.getLngLat(), duration: reduced ? 0 : 600 });
        if (!mk.getPopup().isOpen()) mk.togglePopup();
      };
      r.addEventListener("click", go);
      r.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });
  }
  function select(id) { sel = id; renderHero(); refreshMapSelection(); }

  // ------------------------------------------------------------------ 3 · story
  function renderStory() {
    const full = E.decline.filter(d => d.year < 2026);
    const top = full.reduce((a, b) => (b.days_above > a.days_above ? b : a));
    const last = E.decline[E.decline.length - 1];
    $("#qBody").textContent = t("q.body", { max: top.days_above, maxYear: top.year, last: last.days_above });
    miniBars($("#declineMean"), E.decline.map(d => ({ k: d.year, v: d.mean, partial: d.year === 2026 })), v => no2Color(v), null);
    miniBars($("#declineDays"), E.decline.map(d => ({ k: d.year, v: d.days_above, partial: d.year === 2026 })), () => css("--bad"), 18);
  }
  function miniBars(el, rows, color, capLine) {
    const W = el.clientWidth, H = 150, m = { t: 16, r: 4, b: 20, l: 4 };
    const x = d3.scaleBand().domain(rows.map(r => r.k)).range([m.l, W - m.r]).padding(0.18);
    const y = d3.scaleLinear().domain([0, d3.max(rows, r => r.v) * 1.12]).range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    svg.append("g").selectAll("rect").data(rows).join("rect").attr("x", r => x(r.k)).attr("width", x.bandwidth()).attr("rx", 2.5)
      .attr("y", r => y(r.v)).attr("height", r => y(0) - y(r.v)).attr("fill", r => color(r.v)).attr("opacity", r => (r.partial ? 0.45 : 0.9))
      .on("pointermove", (ev, r) => showTip(`<b>${r.k}${r.partial ? " (Jan–Oct)" : ""}</b><br>${fmt(r.v)}`, ev)).on("pointerleave", hideTip);
    const peak = rows.reduce((a, b) => (b.v > a.v ? b : a)), ends = [peak, rows[rows.length - 1]];
    const top = r => Math.min(y(r.v), capLine != null ? y(capLine) - 2 : Infinity) - 5;
    const every = x.step() >= 30 ? 1 : x.step() >= 15 ? 2 : 3;          // year labels never touch, the latest is always shown
    svg.append("g").selectAll("text").data(ends).join("text").attr("class", "lbl").attr("text-anchor", "middle")
      .attr("x", r => x(r.k) + x.bandwidth() / 2).attr("y", top).text(r => fmt(r.v));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(6).tickValues(rows.filter((r, i) => (rows.length - 1 - i) % every === 0).map(r => r.k)).tickFormat(k => `’${String(k).slice(2)}`));
    if (capLine != null) {
      svg.append("line").attr("class", "limit-line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(capLine)).attr("y2", y(capLine)).style("stroke", css("--ink-2"));
    }
  }

  // ------------------------------------------------------------------ 4 · evidence
  const MCOL = () => ({ persistence: css("--persist"), weekday: css("--faint"), v1: css("--v1"), v2: css("--accent"),
    absolute_2015: css("--line-2"), relative_2015: css("--faint") });

  function renderEvidence() {
    const R = E.results, n = E.data.test_bad_days;
    const ym = s => cap(dname(s, { month: "long", year: "numeric" }));
    $("#evTitle").textContent = t("ev.title", { days: fmt(E.data.test_days) });
    $("#evSub").textContent = t("ev.sub", { from: ym(E.series.dates[0]), to: ym(E.series.dates[E.series.dates.length - 1]) });
    const gain = 100 * (1 - R.v2.mean_abs_error / R.persistence.mean_abs_error);
    const better = E.stations.filter(s => s.v2_gain > 0);
    const v1max = d3.max(E.drift.v1, d => d.bias);
    const kpis = [
      [`−${fmt(gain)}<small>%</small>`, t("kpi1.label"), t("kpi1.note", { m: fmt(R.v2.mean_abs_error, 1), b: fmt(R.persistence.mean_abs_error, 1) })],
      [`${E.budget.v2["30"]}<small> / ${n}</small>`, t("kpi2.label", { fa: 30 }), t("kpi2.note", { b: E.budget.persistence["30"] })],
      [`${better.length}<small> / ${E.stations.length}</small>`, t("kpi3.label"), t("kpi3.note", { lo: fmt(d3.min(better, s => s.v2_gain)), hi: fmt(d3.max(better, s => s.v2_gain)) })],
      [`${R.v2.bias < 0 ? "−" : "+"}${fmt(Math.abs(R.v2.bias), 1)}`, t("kpi4.label"), t("kpi4.note", { v1: fmt(v1max, 1) })],
    ];
    $("#kpis").innerHTML = kpis.map(([v, l, nn]) => `<div class="kpi"><div class="kpi-v">${v}</div><div class="kpi-l">${l}</div><div class="kpi-n">${nn}</div></div>`).join("");
    const d24 = E.drift.v1.find(d => d.year === 2024), d26 = E.drift.v1.find(d => d.year === 2026);
    $("#driftBody").textContent = t("dr.body", { a: fmt(d24.bias, 1), b: fmt(d26.bias, 1), e1: fmt(R.v1.mean_abs_error, 1), e2: fmt(R.v2.mean_abs_error, 1) });
    $("#failSub").textContent = t("fa.sub", { a: fmt(R.v2.mean_abs_error, 1), b: fmt(R.v2_perfect_weather.mean_abs_error, 1) });
    const mid = E.uncertainty.calibration.find(c => c.from === 0.4) || E.uncertainty.calibration[0];
    $("#uncSub").textContent = t("un.sub", { p: fmt(mid.observed * 100), c: fmt(E.uncertainty.coverage_80 * 100) });
    renderSeries(); renderTradeoff(); renderDrift(); renderStations(); renderFails(); renderMonths(); renderCalib(); renderLive();
  }

  function renderSeries() {
    const el = $("#tsChart"), ctxEl = $("#tsContext"), W = el.clientWidth;
    const H = W < 640 ? 250 : 330, H2 = 58, m = { t: 12, r: 10, b: 24, l: 32 };
    const C = MCOL();
    const S = E.series, rows = S.dates.map((d, i) => ({ d: day(d), y: S.measured[i], m: S.v2[i], p: S.persistence[i], key: d }));
    const x = d3.scaleTime().domain(d3.extent(rows, r => r.d)).range([m.l, W - m.r]);
    const x2 = x.copy();
    const y = d3.scaleLinear().range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    svg.append("defs").append("clipPath").attr("id", "tsclip").append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l - m.r).attr("height", H);
    const gGrid = svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`);
    const gY = svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`);
    const gX = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`);
    const plot = svg.append("g").attr("clip-path", "url(#tsclip)");
    const limit = plot.append("line").attr("class", "limit-line");
    const limitLbl = svg.append("text").attr("class", "lbl-m");
    const lineP = plot.append("path").attr("fill", "none").attr("stroke", C.persistence).attr("stroke-width", 1.2).attr("stroke-dasharray", "3 3");
    const lineY = plot.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 1.6);
    const lineM = plot.append("path").attr("fill", "none").attr("stroke", C.v2).attr("stroke-width", 2.2);
    const dots = plot.append("g");
    const hover = svg.append("g").style("display", "none");
    hover.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--line-2"));
    const hy = hover.append("circle").attr("r", 3.5).attr("fill", css("--ink"));
    const hm = hover.append("circle").attr("r", 3.5).attr("fill", C.v2);

    const line = key => d3.line().defined(r => r[key] != null).x(r => x(r.d)).y(r => y(r[key])).curve(d3.curveMonotoneX);
    function draw() {
      const [a, b] = x.domain(), win = rows.filter(r => r.d >= a && r.d <= b);
      y.domain([0, Math.max(60, d3.max(win, r => Math.max(r.y, r.m, r.p)) * 1.08)]).nice();
      gGrid.call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
      gY.call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(6));
      const tv = x.ticks(W < 640 ? 4 : 8), step = Math.ceil(tv.length / Math.max(2, Math.floor((W - m.l - m.r) / 78)));
      gX.call(d3.axisBottom(x).tickValues(tv.filter((_, i) => i % step === 0)).tickSize(0).tickPadding(8)
        .tickFormat(d => `${d.toLocaleDateString(loc(), { month: "short" }).replace(".", "")} ’${String(d.getFullYear()).slice(2)}`));
      limit.attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(F.limit)).attr("y2", y(F.limit));
      limitLbl.attr("x", m.l + 6).attr("text-anchor", "start").attr("y", y(F.limit) - 5).text(`${t("scale.limit")} ${F.limit}`);
      lineP.attr("d", line("p")(win)); lineY.attr("d", line("y")(win)); lineM.attr("d", line("m")(win));
      dots.selectAll("circle").data(win.filter(r => r.y > F.limit), r => r.key).join("circle")
        .attr("r", 3.2).attr("fill", css("--bad")).attr("stroke", css("--surface")).attr("stroke-width", 1.2)
        .attr("cx", r => x(r.d)).attr("cy", r => y(r.y));
    }
    // context strip with brush
    const ctx = svgIn(ctxEl, W, H2);
    const yc = d3.scaleLinear().domain([0, d3.max(rows, r => r.y)]).range([H2 - 18, 4]);
    ctx.append("path").datum(rows).attr("fill", css("--line")).attr("d", d3.area().defined(r => r.y != null).x(r => x2(r.d)).y0(H2 - 18).y1(r => yc(r.y)));
    ctx.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - 18})`)
      .call(d3.axisBottom(x2).ticks(d3.timeYear).tickSize(0).tickPadding(5).tickFormat(d3.timeFormat("%Y")));
    const brush = d3.brushX().extent([[m.l, 2], [W - m.r, H2 - 18]]).on("brush end", ev => {
      const s = ev.selection || x2.range();
      x.domain(s.map(x2.invert)); draw();
    });
    const gb = ctx.append("g").attr("class", "brush").call(brush);
    const end = x2.domain()[1], start = d3.timeDay.offset(end, W < 640 ? -100 : -200);
    gb.call(brush.move, [x2(start), x2(end)]);

    const bis = d3.bisector(r => r.d).center;
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", ev => {
        const [a, b] = x.domain(), win = rows.filter(r => r.d >= a && r.d <= b);
        const r = win[bis(win, x.invert(d3.pointer(ev)[0]))]; if (!r) return;
        hover.style("display", null).attr("transform", `translate(${x(r.d)},0)`);
        hy.attr("cy", y(r.y)); hm.attr("cy", y(r.m));
        showTip(`<b>${cap(r.d.toLocaleDateString(loc(), { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}</b>
          <div class="row"><span><i style="background:${css("--ink")}"></i>${t("ts.measured")}</span><span>${fmt(r.y, 1)}</span></div>
          <div class="row"><span><i style="background:${C.v2}"></i>${t("ts.model")}</span><span>${fmt(r.m, 1)}</span></div>
          <div class="row"><span><i style="background:${C.persistence}"></i>${t("ts.persistence")}</span><span>${fmt(r.p, 1)}</span></div>`, ev);
      })
      .on("pointerleave", () => { hover.style("display", "none"); hideTip(); });
    legend($("#tsLegend"), [[t("ts.measured"), css("--ink"), "line"], [t("ts.model"), C.v2, "line"],
      [t("ts.persistence"), C.persistence, "dash"], [`> ${F.limit} µg/m³`, css("--bad"), "dot"]]);
  }

  function renderTradeoff() {
    const el = $("#tradeoff"), W = el.clientWidth, H = 310, m = { t: 26, r: 14, b: 40, l: 40 };
    const C = MCOL(), n = E.data.test_bad_days, XMAX = 150;
    const x = d3.scaleLinear().domain([0, XMAX]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, n]).range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(6));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(6).tickSize(0).tickPadding(8));
    const xl = svg.append("text").attr("class", "lbl-m").attr("x", W - m.r).attr("y", H - 6).attr("text-anchor", "end").text(t("to.x"));
    if (xl.node().getComputedTextLength() > W - m.l - m.r - 30) xl.text(t("to.x.short"));
    svg.append("text").attr("class", "lbl-m").attr("x", m.l).attr("y", 10).text(t("to.y", { n }));
    const order = ["persistence", "weekday", "v1", "v2"];
    order.forEach(k => {
      const best = new Map();
      E.tradeoff[k].forEach(([fa, c]) => { if (fa <= XMAX) best.set(fa, Math.max(best.get(fa) || 0, c)); });
      let run = 0; const pts = [...best.entries()].sort((a, b) => a[0] - b[0]).map(([fa, c]) => [fa, (run = Math.max(run, c))]);
      pts.push([XMAX, run]);
      const path = svg.append("path").datum(pts).attr("fill", "none").attr("stroke", C[k]).attr("stroke-width", k === "v2" ? 2.6 : 1.6)
        .attr("d", d3.line().x(p => x(p[0])).y(p => y(p[1])).curve(d3.curveStepAfter));
      if (!reduced) { const L0 = path.node().getTotalLength(); path.attr("stroke-dasharray", `${L0} ${L0}`).attr("stroke-dashoffset", L0).transition().duration(1200).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0); }
      const r = E.results[k];
      if (r.false_alarms <= XMAX) {
        svg.append("circle").attr("cx", x(r.false_alarms)).attr("cy", y(r.caught)).attr("r", 5).attr("fill", C[k]).attr("stroke", css("--surface")).attr("stroke-width", 2)
          .on("pointermove", ev => showTip(`<b>${t(`m.${k}`)}</b><br>${t("scale.alert")} > ${fmt(r.alert_at)} µg/m³<br>${r.caught}/${n} · ${r.false_alarms} FA`, ev)).on("pointerleave", hideTip);
      }
    });
    const g = svg.append("g");
    g.append("line").attr("x1", x(30)).attr("x2", x(30)).attr("y1", y(0)).attr("y2", y(E.budget.v2["30"]) - 6).attr("stroke", css("--ink-2")).attr("stroke-dasharray", "2 3");
    g.append("text").attr("class", "lbl").attr("x", x(30) + 6).attr("y", y(E.budget.v2["30"]) - 8).text(E.budget.v2["30"]).style("fill", C.v2).style("font-weight", 700);
    g.append("text").attr("class", "lbl").attr("x", x(30) + 6).attr("y", y(E.budget.persistence["30"]) + 14).text(E.budget.persistence["30"]).style("font-weight", 700);
    const lg = document.createElement("div"); lg.className = "legend"; lg.style.marginTop = "6px";
    el.appendChild(lg); legend(lg, order.map(k => [t(`m.${k}`), C[k], "line"]));
  }

  function renderDrift() {
    const el = $("#drift"), W = el.clientWidth, H = 270, m = { t: 28, r: 40, b: 30, l: 40 };
    const C = MCOL(), keys = ["absolute_2015", "relative_2015", "v1", "v2"];
    const all = keys.flatMap(k => E.drift[k].map(d => d.bias));
    const x = d3.scalePoint().domain([2024, 2025, 2026]).range([m.l + 20, W - m.r - 20]);
    const y = d3.scaleLinear().domain([Math.min(-1.5, d3.min(all) - 0.5), d3.max(all) + 1]).nice().range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(6));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSize(0).tickPadding(10).tickFormat(d3.format("d")));
    svg.append("line").attr("class", "zero-line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(0)).attr("y2", y(0));
    svg.append("text").attr("class", "lbl-m").attr("x", m.l).attr("y", 10).text(t("dr.y"));
    keys.forEach(k => {
      const d = E.drift[k], strong = k === "v1" || k === "v2";
      svg.append("path").datum(d).attr("fill", "none").attr("stroke", C[k]).attr("stroke-width", k === "v2" ? 3 : strong ? 2 : 1.4)
        .attr("d", d3.line().x(p => x(p.year)).y(p => y(p.bias)));
      svg.append("g").selectAll("circle").data(d).join("circle").attr("cx", p => x(p.year)).attr("cy", p => y(p.bias)).attr("r", strong ? 4.5 : 3)
        .attr("fill", C[k]).attr("stroke", css("--surface")).attr("stroke-width", 1.5)
        .on("pointermove", (ev, p) => showTip(`<b>${t(`m.${k}`)} · ${p.year}</b><br>bias ${p.bias > 0 ? "+" : ""}${fmt(p.bias, 1)} · MAE ${fmt(p.mae, 1)} µg/m³`, ev))
        .on("pointerleave", hideTip);
      if (strong) {
        const last = d[d.length - 1];
        svg.append("text").attr("class", "lbl").attr("x", x(last.year) + 8).attr("y", y(last.bias) + 4).style("fill", C[k]).style("font-weight", 700)
          .text(`${last.bias > 0 ? "+" : "−"}${fmt(Math.abs(last.bias), 1)}`);
      }
    });
    const lg = document.createElement("div"); lg.className = "legend"; lg.style.marginTop = "6px";
    el.appendChild(lg); legend(lg, keys.map(k => [t(`m.${k}`), C[k], "line"]));
  }

  function renderStations() {
    const el = $("#stations"), W = el.clientWidth, narrow = W < 640;
    const rows = [...E.stations].sort((a, b) => b.mean_no2 - a.mean_no2);
    const rh = 22, m = { t: 26, r: 46, b: 10, l: narrow ? 128 : 170 }, H = m.t + rows.length * rh + m.b;
    const MIN = -70, C = MCOL();
    const x = d3.scaleLinear().domain([MIN, 50]).range([m.l, W - m.r]);
    const y = d3.scaleBand().domain(rows.map(r => r.name)).range([m.t, H - m.b]).padding(0.3);
    const svg = svgIn(el, W, H);
    svg.append("g").attr("class", "grid").attr("transform", `translate(0,${m.t})`).call(d3.axisTop(x).tickValues(narrow ? [-40, 0, 40] : x.ticks(7)).tickSize(-(H - m.t - m.b)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${m.t})`).call(d3.axisTop(x).tickValues(narrow ? [-40, 0, 40] : x.ticks(7)).tickSize(0).tickPadding(8).tickFormat(v => `${v > 0 ? "+" : ""}${v}%`));
    svg.append("line").attr("class", "zero-line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b);
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", r => `translate(0,${y(r.name) + y.bandwidth() / 2})`);
    g.append("circle").attr("cx", m.l - (narrow ? 120 : 162)).attr("r", 4).attr("fill", r => no2Color(r.mean_no2));
    g.append("text").attr("class", "lbl").attr("x", m.l - (narrow ? 112 : 154)).attr("dy", "0.35em")
      .style("font-weight", r => (r.id === MAIN ? 700 : 500)).text(r => (narrow && r.name.length > 15 ? `${r.name.slice(0, 14)}…` : r.name));
    g.append("line").attr("x1", r => x(Math.max(MIN, r.v1_gain))).attr("x2", r => x(r.v2_gain)).attr("stroke", css("--line-2")).attr("stroke-width", 2);
    g.append("circle").attr("cx", r => x(Math.max(MIN, r.v1_gain))).attr("r", 4.5).attr("fill", C.v1).attr("opacity", 0.85);
    g.filter(r => r.v1_gain < MIN).append("text").attr("class", "lbl-m").attr("x", x(MIN) - 6).attr("dy", "0.35em").attr("text-anchor", "end").text(r => `${fmt(r.v1_gain)}%`);
    g.append("circle").attr("cx", r => x(r.v2_gain)).attr("r", 5.5).attr("fill", C.v2).attr("stroke", css("--surface")).attr("stroke-width", 1.5);
    g.append("text").attr("class", "lbl-m").attr("x", r => x(r.v2_gain) + 9).attr("dy", "0.35em").text(r => `+${fmt(r.v2_gain)}%`);
    g.append("rect").attr("x", 0).attr("width", W).attr("y", -rh / 2).attr("height", rh).attr("fill", "transparent")
      .on("pointermove", (ev, r) => showTip(`<b>${esc(r.name)}</b> · ${typeName(r.type)}<br>NO₂ ${fmt(r.mean_no2, 1)} µg/m³<br>
        <div class="row"><span>${t("m.persistence")}</span><span>${fmt(r.persistence_mae, 1)}</span></div>
        <div class="row"><span>${t("m.v1")}</span><span>${fmt(r.v1_mae, 1)}</span></div>
        <div class="row"><span>${t("m.v2")}</span><span>${fmt(r.v2_mae, 1)}</span></div>`, ev))
      .on("pointerleave", hideTip);
    const bl = svg.append("text").attr("class", "lbl-m").attr("x", x(0) + 4).attr("y", H - 2).text(`← ${t("st.baseline")}`);
    if (x(0) + 4 + bl.node().getComputedTextLength() > W) bl.attr("x", x(0) - 4).attr("text-anchor", "end").text(`${t("st.baseline")} →`);
    legend($("#stLegend"), [[t("m.v1"), C.v1, "dot"], [t("m.v2"), C.v2, "dot"]]);
  }

  function renderFails() {
    $("#fails").innerHTML = E.missed.slice(0, 3).map(f => `<div class="fail">
      <div class="fail-date">${dname(f.date, { day: "numeric", month: "short", year: "numeric" })}<b>${fmt(f.measured)}</b></div>
      <div class="fail-txt">${t("fa.card", { m: fmt(f.measured), f: fmt(f.forecast), t: fmt(f.today), w: fmt(f.wind), rain: f.rain < 0.05 ? t("fa.norain") : t("fa.rain", { r: fmt(f.rain, 1) }) })}</div></div>`).join("");
  }

  function renderMonths() {
    const el = $("#months"), W = el.clientWidth, H = 150, m = { t: 8, r: 4, b: 20, l: 26 }, C = MCOL();
    const rows = E.by_month;
    const x = d3.scaleBand().domain(rows.map(r => r.month)).range([m.l, W - m.r]).padding(0.25);
    const xi = d3.scaleBand().domain(["model", "persistence"]).range([0, x.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear().domain([0, d3.max(rows, r => r.persistence) * 1.05]).nice(3).range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(5));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(6).tickFormat(mm => new Date(2026, mm - 1, 1).toLocaleDateString(loc(), { month: "narrow" })));
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("transform", r => `translate(${x(r.month)},0)`);
    ["model", "persistence"].forEach(k => g.append("rect").attr("x", xi(k)).attr("width", xi.bandwidth()).attr("rx", 2)
      .attr("y", r => y(r[k])).attr("height", r => y(0) - y(r[k])).attr("fill", k === "model" ? C.v2 : C.persistence)
      .on("pointermove", (ev, r) => showTip(`<b>${new Date(2026, r.month - 1, 1).toLocaleDateString(loc(), { month: "long" })}</b>
        <div class="row"><span>${t("fa.model")}</span><span>${fmt(r.model, 1)}</span></div>
        <div class="row"><span>${t("fa.base")}</span><span>${fmt(r.persistence, 1)}</span></div>`, ev)).on("pointerleave", hideTip));
    legend($("#monthLegend"), [[t("fa.model"), C.v2], [t("fa.base"), C.persistence]]);
  }

  function renderCalib() {
    const el = $("#calib"), W = el.clientWidth, H = 240, m = { t: 24, r: 14, b: 38, l: 42 };
    const x = d3.scaleLinear().domain([-0.1, 1]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([-0.1, 1]).range([H - m.b, m.t]);
    const r = d3.scaleSqrt().domain([0, d3.max(E.uncertainty.calibration, c => c.days)]).range([3, 14]);
    const svg = svgIn(el, W, H), pc = d3.format(".0%");
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues([0, .25, .5, .75, 1]).tickSize(0).tickPadding(6).tickFormat(pc));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([0, .25, .5, .75, 1]).tickSize(0).tickPadding(8).tickFormat(pc));
    svg.append("line").attr("x1", x(0)).attr("y1", y(0)).attr("x2", x(1)).attr("y2", y(1)).attr("stroke", css("--faint")).attr("stroke-dasharray", "4 4");
    svg.append("text").attr("class", "lbl-m").attr("x", W - m.r).attr("y", H - 4).attr("text-anchor", "end").text(t("un.x"));
    svg.append("text").attr("class", "lbl-m").attr("x", m.l).attr("y", 10).text(t("un.y"));
    svg.append("g").selectAll("circle").data(E.uncertainty.calibration).join("circle")
      .attr("cx", c => x(c.predicted)).attr("cy", c => y(c.observed)).attr("r", c => r(c.days))
      .attr("fill", css("--accent")).attr("fill-opacity", 0.22).attr("stroke", css("--accent")).attr("stroke-width", 1.5)
      .on("pointermove", (ev, c) => showTip(`<b>${pc(c.from)}–${pc(c.to)}</b><br>${fmt(c.days)} ${t("un.days")}<br>${t("un.x")}: ${pc(c.predicted)}<br>${t("un.y")}: ${pc(c.observed)}`, ev))
      .on("pointerleave", hideTip);
  }

  function renderLive() {
    const T = F.track_record || {};
    $("#liveBody").textContent = t("live.body", { since: dname(T.since || F.today, { day: "numeric", month: "long", year: "numeric" }) });
    const pub = T.published || 1, lines = [t(pub === 1 ? "live.stats1" : "live.stats", { p: pub, v: T.verified_forecasts || 0 })];
    lines.push(T.verified_forecasts ? t("live.mae", { mae: fmt(T.mae, 1) }) : t("live.none"));
    $("#liveStats").innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join("");
  }

  // ------------------------------------------------------------------ 5 · how it works
  const STEP_ICONS = [
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="20" width="20" height="20" rx="3"/><path d="M24 20v-6M18 10a8.5 8.5 0 0 1 12 0M14.5 6.5a13.5 13.5 0 0 1 19 0"/><path d="M19 30h10M19 35h6"/></svg>',
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 27a7 7 0 0 1-.5-13.97A9.5 9.5 0 0 1 31 13a6.5 6.5 0 0 1 1 12.95"/><path d="M17 31l-2 4M23 31l-2 4"/><rect x="27" y="28" width="16" height="15" rx="2.5"/><path d="M27 33h16M31 26v4M39 26v4"/></svg>',
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="14" r="3"/><circle cx="10" cy="34" r="3"/><circle cx="24" cy="10" r="3"/><circle cx="24" cy="24" r="3"/><circle cx="24" cy="38" r="3"/><circle cx="38" cy="24" r="4"/><path d="M13 14l8-3M13 14l8 9M13 34l8-9M13 34l8 3M27 10l8 12M27 24h7M27 38l8-12"/></svg>',
    '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M38 24a14 14 0 1 1-4.1-9.9"/><path d="M38 9v7h-7"/><path d="M18 25l4 4 8-9"/></svg>',
  ];
  function renderHow() {
    const vals = { n: fmt(E.data.hourly_values / 1e6, 1), a: fmt(E.alert_at) };
    $("#steps").innerHTML = [1, 2, 3, 4].map(i => `<li class="step"><div class="step-n">0${i}</div>${STEP_ICONS[i - 1]}
      <h3>${t(`how.s${i}.t`)}</h3><p>${t(`how.s${i}.b`, vals)}</p></li>`).join("");
    $("#timeline").innerHTML = ["train", "val", "test", "live"].map(k => `<div class="tl tl-${k}"><b>${t(`tl.${k}`)}</b><span>${t(`tl.${k}.n`)}</span></div>`).join("");
  }

  // ------------------------------------------------------------------ boot
  function renderCharts() {
    if (!F) return;
    const s = station(sel);
    if (s && s.status === "ok") renderHistory(s);
    renderStory(); renderEvidence();
  }
  function renderAll() {
    applyStatic(); renderHero(); renderWeather(); renderMap(); renderStory(); renderEvidence(); renderHow();
  }

  document.querySelectorAll(".lang button").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.lang === lang) return;
    lang = b.dataset.lang; store.set("lang", lang);
    if (F) renderAll(); else applyStatic();
  }));

  // Redraw the charts whenever the width of the page content really changes (window resize, zoom, rotation).
  let lastW = 0, timer;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (!lastW) { lastW = w; return; }
    if (Math.abs(w - lastW) < 2) return;
    lastW = w; clearTimeout(timer); timer = setTimeout(renderCharts, 120);
  }).observe(document.querySelector("main"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => location.reload());

  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach(el => io.observe(el));

  applyStatic();
  const bust = `?v=${Math.floor(Date.now() / 600000)}`;            // fresh data every 10 minutes
  Promise.all([fetch(`data/forecast.json${bust}`).then(r => r.json()), fetch(`data/evaluation.json${bust}`).then(r => r.json())])
    .then(([f, e]) => {
      F = f; E = e;
      if (!station(sel) || station(sel).status !== "ok") sel = (F.stations.find(s => s.status === "ok") || F.stations[0]).id;
      $("#status").hidden = true; $("#hero").hidden = false;
      renderAll();
    })
    .catch(err => { console.error(err); $("#status").textContent = t("error"); });
})();
