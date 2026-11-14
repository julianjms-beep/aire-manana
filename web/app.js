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
  let F = null, E = null, P = null, SCH = null, LOG = null, school = null, sel = MAIN, map = null, markers = {}, schoolMarker = null;
  const params = new URLSearchParams(location.search);

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
    $("#schoolInput").placeholder = t("school.ph", { n: fmt(SCH ? SCH.length : 1253) });
    $("#schoolInput").setAttribute("aria-label", t("school.label"));
    $("#schoolClear").setAttribute("aria-label", t("school.clear")); $("#shareClose").setAttribute("aria-label", t("share.close"));
    $("#liveLog").href = `${REPO}/blob/main/web/data/log.csv`; $("#liveCommits").href = `${REPO}/commits/main/web/data/log.csv`;
  }
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("on");
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 1800);
  }
  async function copyText(x, msg) {
    try { await navigator.clipboard.writeText(x); } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: x }); document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* nothing else to try */ } ta.remove();
    }
    toast(msg);
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
    renderSchoolChip(); updateActions(s);

    const v = $("#verdict");
    v.className = `verdict ${ok ? lv : ""}`;
    if (!ok) {
      $("#bigNum").textContent = "–"; $("#bigNum").dataset.v = 0;
      $("#verdictTitle").textContent = t("map.nodata"); $("#verdictSub").textContent = t("nodata");
      ["#statChance", "#statRange", "#statToday"].forEach(id => { $(id).textContent = "–"; });
      $("#statTodayNote").textContent = ""; $("#scale").innerHTML = ""; $("#why").innerHTML = "";
      d3.select("#histChart").selectAll("*").remove(); renderBest(null);
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
    renderBest(s);
    renderWhy(s);
  }

  // ------------------------------------------------------------------ best time of day for outdoor PE
  function tomorrowKey() {
    const d = day(F.tomorrow), wd = d.getDay();
    const type = F.holiday_tomorrow || wd === 0 ? 2 : wd === 6 ? 1 : 0;
    return { type, key: `${type}${d.getMonth() >= 3 && d.getMonth() <= 8 ? 1 : 0}` };
  }
  function bestFor(s) {
    if (!P || !s || s.status !== "ok") return null;
    const { type, key } = tomorrowKey();
    const shape = (P.shape[String(s.id)] || {})[key];
    if (!shape) return null;
    const est = shape.map(r => s.forecast * r);
    const a = P.windows.reduce((b, w) => (shape[w] + shape[w + 1] < shape[b] + shape[b + 1] ? w : b), P.windows[0]);
    return { type, est, a, v: (est[a] + est[a + 1]) / 2, morning: (est[9] + est[10]) / 2, label: `${a}:00–${a + 2}:00` };
  }
  function renderBest(s) {
    const b = bestFor(s), card = $("#bestChart").closest(".card");
    card.hidden = !b;
    if (!b) return;
    $("#bestTitle").textContent = t(b.type === 0 ? "best.title" : "best.titlefree");
    $("#bestPill").textContent = b.label;
    const free = b.type === 0 ? "" : `${t("best.free", { day: dname(F.tomorrow, { weekday: "long" }) })} `;
    $("#bestSub").textContent = free + (s.forecast < 20 ? t("best.subclean", { v: fmt(b.v) }) : t("best.sub", { v: fmt(b.v), m: fmt(b.morning) }));
    $("#bestNote").textContent = t("best.note", { n: fmt(P.check.station_days), p: fmt(P.check.less_than_school_day_pct) });

    const el = $("#bestChart"), W = el.clientWidth, H = 150, m = { t: 22, r: 14, b: 22, l: 28 };
    const x = d3.scaleLinear().domain([0, 24]).range([m.l, W - m.r]);
    const y = d3.scaleLinear().domain([0, Math.max(10, d3.max(b.est) * 1.15)]).nice(3).range([H - m.b, m.t]);
    const svg = svgIn(el, W, H);
    svg.append("rect").attr("class", "best-band").attr("x", x(9)).attr("width", x(17) - x(9)).attr("y", m.t - 14).attr("height", H - m.b - m.t + 14).attr("rx", 6);
    svg.append("text").attr("class", "lbl-m").attr("x", x(9) + 6).attr("y", m.t - 4).text(t("best.school"));
    svg.append("rect").attr("class", "best-win").attr("x", x(b.a)).attr("width", x(b.a + 2) - x(b.a)).attr("y", m.t).attr("height", H - m.b - m.t).attr("rx", 5);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickSize(-(W - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(6));
    const pts = b.est.map((v, h) => [h + 0.5, v]);
    svg.append("path").attr("class", "best-area").attr("d", d3.area().x(d => x(d[0])).y0(y(0)).y1(d => y(d[1])).curve(d3.curveMonotoneX)(pts));
    svg.append("path").attr("class", "best-line").attr("d", d3.line().x(d => x(d[0])).y(d => y(d[1])).curve(d3.curveMonotoneX)(pts));
    svg.append("circle").attr("cx", x(b.a + 1)).attr("cy", y(b.v)).attr("r", 4.5).attr("fill", css("--good")).attr("stroke", css("--surface")).attr("stroke-width", 2);
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(W < 360 ? [0, 9, 17, 24] : [0, 6, 9, 12, 15, 17, 21, 24]).tickSize(0).tickPadding(7).tickFormat(h => `${h}h`));
    svg.append("g").selectAll("rect").data(d3.range(24)).join("rect").attr("x", h => x(h)).attr("width", x(1) - x(0)).attr("y", m.t).attr("height", H - m.b - m.t)
      .attr("fill", "transparent")
      .on("pointermove", (ev, h) => showTip(t("best.hour", { h, h2: h + 1, v: fmt(b.est[h]) }), ev)).on("pointerleave", hideTip);
  }

  // ------------------------------------------------------------------ actions: share, calendar, poster, install
  const placeName = s => (school ? school.name : s.name);
  function shareUrl() {
    const u = new URL(location.pathname, location.origin);
    if (school) u.searchParams.set("sc", school.id); else u.searchParams.set("st", sel);
    u.searchParams.set("lang", lang);
    return u.toString();
  }
  function calUrls(s) {
    const https = new URL(`cal/${s.id}-${lang}.ics`, location.href).toString();
    const webcal = https.replace(/^https?:/, "webcal:");
    return { https, webcal, google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`,
      outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(`AireMañana · ${s.name}`)}` };
  }
  function updateActions(s) {
    const u = calUrls(s);
    $("#calApple").href = u.webcal; $("#calGoogle").href = u.google; $("#calOutlook").href = u.outlook;
    $("#actPoster").href = `poster.html?st=${s.id}${school ? `&sc=${school.id}` : ""}&lang=${lang}`;
  }
  const calBtn = $("#actCal"), calMenu = $("#calMenu");
  const closeCal = () => { calMenu.hidden = true; calBtn.setAttribute("aria-expanded", "false"); };
  calBtn.addEventListener("click", () => { calMenu.hidden = !calMenu.hidden; calBtn.setAttribute("aria-expanded", String(!calMenu.hidden)); });
  calMenu.addEventListener("click", ev => { if (ev.target.closest("a")) setTimeout(closeCal, 50); });
  $("#calCopy").addEventListener("click", () => { copyText(calUrls(station(sel)).https, t("cal.copied")); closeCal(); });
  document.addEventListener("pointerdown", ev => { if (!calMenu.hidden && !ev.target.closest(".act-wrap")) closeCal(); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !calMenu.hidden) { closeCal(); calBtn.focus(); } });

  let installEvt = null;
  addEventListener("beforeinstallprompt", ev => { ev.preventDefault(); installEvt = ev; $("#actInstall").hidden = false; });
  $("#actInstall").addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; $("#actInstall").hidden = true;
  });
  addEventListener("appinstalled", () => { $("#actInstall").hidden = true; });

  // Share image (1080 × 1350) drawn on a canvas, always in the light theme so it reads well in any chat.
  function wrapText(ctx, text, maxW, maxLines) {
    const words = String(text).split(" "), lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    lines.push(cur);
    if (lines.length > maxLines) {
      const keep = lines.slice(0, maxLines);
      let last = keep[maxLines - 1];
      while (ctx.measureText(`${last}…`).width > maxW && last.length) last = last.slice(0, -1);
      keep[maxLines - 1] = `${last.trim()}…`;
      return keep;
    }
    return lines;
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  async function shareImage(s) {
    const C = { bg: "#F5F4EF", ink: "#101317", ink2: "#3E444C", muted: "#7C828B", line: "#E4E1D9",
      ok: ["#14A06B", "#E2F3EB"], watch: ["#B7820C", "#FBF1DC"], alert: ["#DE3D33", "#FCE5E2"] };
    try {
      await Promise.all(['400 100px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '600 34px "Geist"', '400 30px "Geist"', '500 26px "Geist Mono"']
        .map(f => document.fonts.load(f)));
    } catch { /* system fonts are fine */ }
    const W = 1080, H = 1350, P0 = 84, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), lv = level(s), [col, soft] = C[lv], b = bestFor(s);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.15, -80, 40, W * 0.15, -80, 900);
    g.addColorStop(0, `${col}33`); g.addColorStop(1, `${col}00`); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // brand
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(P0 + 24, 104, 24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.bg; ctx.lineWidth = 3.6; ctx.lineCap = "round";
    const wave = (yy, a) => { ctx.globalAlpha = a; ctx.beginPath(); ctx.moveTo(P0 + 9, yy); ctx.bezierCurveTo(P0 + 16, yy - 7, P0 + 22, yy - 7, P0 + 24, yy); ctx.bezierCurveTo(P0 + 27, yy + 7, P0 + 33, yy + 7, P0 + 39, yy); ctx.stroke(); ctx.globalAlpha = 1; };
    wave(110, 1); wave(99, 0.55);
    ctx.fillStyle = C.ink; ctx.font = '600 34px "Geist", sans-serif'; ctx.textBaseline = "middle"; ctx.fillText("Aire", P0 + 62, 106);
    const aw = ctx.measureText("Aire").width; ctx.font = 'italic 400 42px "Instrument Serif", serif'; ctx.fillText("Mañana", P0 + 64 + aw, 104);
    ctx.font = '500 24px "Geist Mono", monospace'; ctx.fillStyle = C.muted; ctx.textAlign = "right";
    ctx.fillText(dname(F.tomorrow, { weekday: "long", day: "numeric", month: "long" }).toUpperCase(), W - P0, 106);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    // place
    ctx.font = '400 84px "Instrument Serif", serif'; ctx.fillStyle = C.ink;
    const lines = wrapText(ctx, placeName(s), W - 2 * P0, 2);
    lines.forEach((l, i) => ctx.fillText(l, P0, 268 + i * 86));
    let yy = 268 + (lines.length - 1) * 86 + 52;
    ctx.font = '400 30px "Geist", sans-serif'; ctx.fillStyle = C.muted;
    ctx.fillText(school ? `${t("share.station", { s: s.name })} · ${fmt(school.km, 1)} km` : typeName(s.type), P0, yy);
    // number
    yy += 330;
    ctx.font = '400 360px "Instrument Serif", serif'; ctx.fillStyle = C.ink;
    const num = String(Math.round(s.forecast)); ctx.fillText(num, P0 - 8, yy);
    const nw = ctx.measureText(num).width;
    ctx.font = '400 32px "Geist", sans-serif'; ctx.fillStyle = C.ink2;
    wrapText(ctx, t("hero.unit"), 360, 2).forEach((l, i) => ctx.fillText(l, P0 + nw + 26, yy - 50 + i * 40));
    // verdict pill
    yy += 70;
    ctx.font = '600 36px "Geist", sans-serif';
    const vt = wrapText(ctx, t(`verdict.${lv}`), W - 2 * P0 - 110, 2);
    const ph = 44 + vt.length * 46, pw = Math.min(W - 2 * P0, Math.max(...vt.map(l => ctx.measureText(l).width)) + 110);
    ctx.fillStyle = soft; roundRect(ctx, P0, yy, pw, ph, 28); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(P0 + 46, yy + ph / 2, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.ink; vt.forEach((l, i) => ctx.fillText(l, P0 + 80, yy + 58 + i * 46));
    yy += ph + 64;
    // best window
    if (b) {
      ctx.font = '400 32px "Geist", sans-serif'; ctx.fillStyle = C.ink2;
      ctx.fillText(t(b.type === 0 ? "share.best" : "share.bestfree", { w: b.label }), P0, yy); yy += 56;
    }
    // scale
    const sx = P0, sw = W - 2 * P0, max = Math.max(80, Math.ceil((s.high * 1.1) / 10) * 10), px = v => sx + (Math.min(v, max) / max) * sw;
    const gr = ctx.createLinearGradient(sx, 0, sx + sw, 0);
    [[0, "#14A06B"], [0.22, "#6CC07A"], [0.44, "#D99E12"], [0.56, "#EC7430"], [0.66, "#DE3D33"], [1, "#A9233A"]].forEach(([o, c]) => gr.addColorStop(o, c));
    yy = Math.max(yy, 1110);
    ctx.fillStyle = gr; roundRect(ctx, sx, yy, sw, 14, 7); ctx.fill();
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.arc(px(s.forecast), yy + 7, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(px(s.forecast), yy + 7, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#DE3D33"; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(px(F.limit), yy - 16); ctx.lineTo(px(F.limit), yy + 30); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '500 22px "Geist Mono", monospace'; ctx.fillStyle = "#DE3D33"; ctx.textAlign = "center";
    ctx.fillText(`${t("scale.limit")} ${F.limit}`, px(F.limit), yy - 26); ctx.textAlign = "left";
    // footer
    ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(P0, H - 150); ctx.lineTo(W - P0, H - 150); ctx.stroke();
    ctx.font = '500 26px "Geist Mono", monospace'; ctx.fillStyle = C.ink; ctx.fillText("julianjms-beep.github.io/aire-manana", P0, H - 98);
    ctx.font = '400 24px "Geist", sans-serif'; ctx.fillStyle = C.muted; ctx.fillText(t("share.foot"), P0, H - 58);
    return new Promise(res => cv.toBlob(res, "image/png"));
  }
  let shareBlobUrl = null;
  $("#actShare").addEventListener("click", async () => {
    const s = station(sel); if (!s || s.status !== "ok") return;
    const blob = await shareImage(s), url = shareUrl();
    const text = t("share.text", { place: placeName(s), v: fmt(s.forecast), verdict: t(`verdict.${level(s)}`), url });
    if (shareBlobUrl) URL.revokeObjectURL(shareBlobUrl);
    shareBlobUrl = URL.createObjectURL(blob);
    $("#shareImg").src = shareBlobUrl; $("#shareImg").alt = text;
    $("#shareDl").href = shareBlobUrl;
    $("#shareWa").href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    const file = new File([blob], "airemanana.png", { type: "image/png" });
    const canFiles = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const nat = $("#shareNative"); nat.hidden = !canFiles && !navigator.share;
    nat.onclick = async () => {
      try { await navigator.share(canFiles ? { files: [file], text } : { text, url }); } catch { /* cancelled */ }
    };
    $("#shareCopy").onclick = () => copyText(url, t("share.copied"));
    $("#shareDialog").showModal();
  });
  $("#shareClose").addEventListener("click", () => $("#shareDialog").close());
  $("#shareDialog").addEventListener("click", ev => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });

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
        const b = ev.target.closest("[data-go]"), sb = ev.target.closest("[data-school]");
        if (b) { select(Number(b.dataset.go)); $("#forecast").scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); }
        if (sb && SCH) {
          const x = SCH.find(r => r.id === Number(sb.dataset.school));
          if (x) { setSchool(x, false); document.querySelectorAll(".map-school-pop").forEach(p => p.remove()); $("#forecast").scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); }
        }
      });
      map.on("load", () => { addSchoolLayer(); showSchoolMarker(); });
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
  function syncUrl() {
    const u = new URL(location.href);
    u.searchParams.delete("st"); u.searchParams.delete("sc");
    if (school) u.searchParams.set("sc", school.id); else if (sel !== MAIN) u.searchParams.set("st", sel);
    history.replaceState(null, "", u);
  }
  function select(id) {
    if (school && school.station !== id) { school = null; showSchoolMarker(); }
    sel = id; renderHero(); refreshMapSelection(); syncUrl();
  }

  // ------------------------------------------------------------------ schools
  const SCHOOL_TYPES = { en: [], es: [] };
  let schoolsP = null;
  function loadSchools() {
    return schoolsP || (schoolsP = fetch("data/schools.json").then(r => r.json()).then(j => {
      SCH = j.schools.map(([id, name, type, lat, lon, st, kmv, district, hood]) => ({ id, name, type, lat, lon, station: st, km: kmv, district, hood }));
      for (const l of ["en", "es"]) SCHOOL_TYPES[l] = [0, 1, 2, 3, 4, 5, 6].map(i => I18N[l][`school.t${i}`]);
      SCH.forEach(x => { x.fname = fold(x.name); x.key = fold([x.name, SCHOOL_TYPES.en[x.type], SCHOOL_TYPES.es[x.type], x.district, x.hood].join(" ")); });
      $("#schoolInput").placeholder = t("school.ph", { n: fmt(SCH.length) });
      addSchoolLayer();
      const sc = Number(params.get("sc"));
      if (sc) { const x = SCH.find(r => r.id === sc); if (x) setSchool(x, false); }
      if (document.activeElement === sch.input && sch.input.value.trim().length >= 2) renderSchoolList();
    }).catch(err => console.warn("schools", err)));
  }
  const schoolType = x => t(`school.t${x.type}`);
  function searchSchools(q) {
    const toks = fold(q).split(/\s+/).filter(Boolean);
    if (!toks.length || !SCH) return [];
    const hits = [];
    for (const x of SCH) if (toks.every(k => x.key.includes(k))) {
      const i = x.fname.indexOf(toks[0]);
      const score = (i === 0 ? 0 : i > 0 && x.fname[i - 1] === " " ? 1 : i > 0 ? 2 : 3) * 1000 + x.name.length;
      hits.push([score, x]);
    }
    return hits.sort((a, b) => a[0] - b[0]).slice(0, 8).map(h => h[1]);
  }
  function highlight(name, q) {
    const f = fold(name), toks = fold(q).split(/\s+/).filter(Boolean), on = new Array(name.length).fill(false);
    toks.forEach(k => { let i = f.indexOf(k); while (i >= 0) { for (let j = i; j < i + k.length; j++) on[j] = true; i = f.indexOf(k, i + k.length); } });
    let out = "", open = false;
    [...name].forEach((ch, i) => { if (on[i] !== open) { out += on[i] ? "<mark>" : "</mark>"; open = on[i]; } out += esc(ch); });
    return out + (open ? "</mark>" : "");
  }
  const sch = { input: $("#schoolInput"), list: $("#schoolList"), rows: [], active: -1 };
  function renderSchoolList() {
    const q = sch.input.value.trim();
    sch.rows = q.length >= 2 ? searchSchools(q) : [];
    sch.active = sch.rows.length ? 0 : -1;
    if (q.length < 2) { sch.list.hidden = true; sch.input.setAttribute("aria-expanded", "false"); return; }
    sch.list.innerHTML = sch.rows.length ? sch.rows.map((x, i) => {
      const st = station(x.station);
      return `<li role="option" id="sch-${x.id}" data-i="${i}" class="${i === 0 ? "active" : ""}" aria-selected="${i === 0}">${highlight(x.name, q)}
        <small>${esc(schoolType(x))} · ${esc(x.district)} · ${esc(st ? st.name : "")} ${fmt(x.km, 1)} km</small></li>`;
    }).join("") : `<li class="empty">${esc(t(SCH ? "school.none" : "loading"))}</li>`;
    sch.list.hidden = false; sch.input.setAttribute("aria-expanded", "true");
    if (sch.rows.length) sch.input.setAttribute("aria-activedescendant", `sch-${sch.rows[0].id}`); else sch.input.removeAttribute("aria-activedescendant");
  }
  function moveSchool(i) {
    const items = [...sch.list.querySelectorAll("li[data-i]")];
    if (!items.length) return;
    sch.active = (i + items.length) % items.length;
    items.forEach((li, j) => { li.classList.toggle("active", j === sch.active); li.setAttribute("aria-selected", String(j === sch.active)); });
    items[sch.active].scrollIntoView({ block: "nearest" });
    sch.input.setAttribute("aria-activedescendant", items[sch.active].id);
  }
  function closeSchoolList() { sch.list.hidden = true; sch.input.setAttribute("aria-expanded", "false"); }
  function setSchool(x, focusChip = true) {
    school = x; sch.input.value = ""; closeSchoolList();
    sel = x.station; renderHero(); refreshMapSelection(); showSchoolMarker(); syncUrl();
    if (focusChip) $("#schoolClear").focus({ preventScroll: true });
  }
  function clearSchool() {
    school = null; renderSchoolChip(); showSchoolMarker(); syncUrl(); updateActions(station(sel));
    sch.input.focus({ preventScroll: true });
  }
  function renderSchoolChip() {
    $("#schoolChip").hidden = !school; $("#schoolSearch").hidden = !!school;
    if (!school) return;
    $("#schoolName").textContent = school.name;
    $("#schoolMeta").textContent = school.km > 3 ? t("school.far", { d: fmt(school.km, 1) })
      : `${schoolType(school)} · ${t("school.chip", { d: fmt(school.km, 1) })}`;
  }
  sch.input.addEventListener("input", renderSchoolList);
  sch.input.addEventListener("focus", () => { if (!SCH) loadSchools(); if (sch.input.value.trim().length >= 2) renderSchoolList(); });
  sch.input.addEventListener("keydown", ev => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); if (sch.list.hidden) renderSchoolList(); else moveSchool(sch.active + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); moveSchool(sch.active - 1); }
    else if (ev.key === "Enter") { if (sch.rows[sch.active]) { ev.preventDefault(); setSchool(sch.rows[sch.active]); } }
    else if (ev.key === "Escape") { if (!sch.list.hidden) { ev.preventDefault(); closeSchoolList(); } else sch.input.value = ""; }
  });
  sch.list.addEventListener("pointerdown", ev => ev.preventDefault());            // keep focus in the input
  sch.list.addEventListener("click", ev => { const li = ev.target.closest("li[data-i]"); if (li) setSchool(sch.rows[Number(li.dataset.i)]); });
  sch.input.addEventListener("blur", () => setTimeout(closeSchoolList, 120));
  $("#schoolClear").addEventListener("click", clearSchool);

  function schoolPopupHtml(x) {
    const st = station(x.station), ok = st && st.status === "ok", lv = ok ? level(st) : "ok";
    return `<div class="pop"><div class="pop-name">${esc(x.name)}</div><div class="pop-meta">${esc(schoolType(x))} · ${esc(x.district)}</div>
      ${ok ? `<div class="pop-verdict ${lv}"><i></i>${t(`verdict.${lv}`)}</div>
      <div class="pop-meta">${esc(st.name)} · ${fmt(x.km, 1)} km · ${fmt(st.forecast)} µg/m³</div>` : ""}
      <button class="pop-btn" type="button" data-school="${x.id}">${t("map.open")} ↑</button></div>`;
  }
  function addSchoolLayer() {
    if (!map || !SCH || !map.isStyleLoaded() || map.getSource("schools")) return;
    map.addSource("schools", { type: "geojson", data: { type: "FeatureCollection", features: SCH.map(x => ({
      type: "Feature", id: x.id, properties: { id: x.id }, geometry: { type: "Point", coordinates: [x.lon, x.lat] } })) } });
    map.addLayer({ id: "schools", type: "circle", source: "schools", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.6, 12, 3, 15, 6],
      "circle-color": css("--accent"), "circle-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.35, 13, 0.7],
      "circle-stroke-color": css("--surface"), "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0, 13, 1] } });
    const pop = new maplibregl.Popup({ closeButton: false, offset: 10, className: "pop-wrap map-school-pop", maxWidth: "270px" });
    map.on("click", "schools", e => {
      const x = SCH.find(r => r.id === e.features[0].properties.id); if (!x) return;
      closePopups(); pop.setLngLat([x.lon, x.lat]).setHTML(schoolPopupHtml(x)).addTo(map);
    });
    map.on("mouseenter", "schools", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "schools", () => { map.getCanvas().style.cursor = ""; });
    const box = $(".map-box"), tg = document.createElement("label");
    tg.className = "map-toggle"; tg.innerHTML = `<input type="checkbox" checked> <span>${esc(t("school.map"))}</span>`;
    tg.querySelector("input").addEventListener("change", ev => map.setLayoutProperty("schools", "visibility", ev.target.checked ? "visible" : "none"));
    box.appendChild(tg);
  }
  function showSchoolMarker() {
    if (schoolMarker) { schoolMarker.remove(); schoolMarker = null; }
    if (!map || !school) return;
    const el = document.createElement("div");
    el.className = "school-pin"; el.title = school.name;
    el.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 9l7-5 7 5M5 8v8h10V8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    schoolMarker = new maplibregl.Marker({ element: el }).setLngLat([school.lon, school.lat]).addTo(map);
  }

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
    const draw = rows => {
      LOG = rows;
      const num = v => (v === "" || v == null ? null : Number(v));
      const R = rows.map(r => ({ issued: r.issued, day: r.for_day, st: Number(r.station), f: num(r.forecast), m: num(r.measured), p: num(r.persistence) }));
      const byIssued = d3.groups(R, r => r.issued).sort((a, b) => d3.descending(a[0], b[0]));
      const done = R.filter(r => r.m != null), base = done.filter(r => r.p != null);
      const first = byIssued.length ? byIssued[byIssued.length - 1][1][0].day : F.tomorrow;
      const checkDay = d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(day(first), 1));
      const k = [[fmt(byIssued.length), t("live2.pub")], [fmt(R.length), t("live2.saved")], [fmt(done.length), t("live2.checked")],
        base.length ? [t("live2.errv", { m: fmt(d3.mean(base, r => Math.abs(r.f - r.m)), 1), b: fmt(d3.mean(base, r => Math.abs(r.p - r.m)), 1) }), t("live2.err")]
          : [`<span style="font-size:22px">${esc(t("live2.pending", { d: dname(checkDay, { weekday: "long", day: "numeric", month: "short" }) }))}</span>`, t("live2.err")]];
      $("#liveKpis").innerHTML = k.map(([v, l]) => `<div><b>${v}</b><span>${esc(l)}</span></div>`).join("");
      const dd = x => dname(x, { weekday: "short", day: "numeric", month: "short" });
      const head = `<thead><tr><th>${t("live2.c.issued")}</th><th>${t("live2.c.for")}</th><th>${t("live2.c.fc")}</th><th>${t("live2.c.meas")}</th><th>${t("live2.c.all")}</th></tr></thead>`;
      const body = byIssued.slice(0, 7).map(([iss, rs]) => {
        const main = rs.find(r => r.st === MAIN), chk = rs.filter(r => r.m != null);
        const wait = `<span class="wait">${t("live2.wait")}</span>`;
        return `<tr><td>${dd(iss)}</td><td>${dd(rs[0].day)}</td>
          <td class="n">${main ? `<span class="dot" style="background:${no2Color(main.f)}"></span>${fmt(main.f)}` : "–"}</td>
          <td class="n">${main && main.m != null ? fmt(main.m) : wait}</td>
          <td class="n">${chk.length ? `${fmt(d3.mean(chk, r => Math.abs(r.f - r.m)), 1)} <span class="wait">(${chk.length})</span>` : wait}</td></tr>`;
      }).join("");
      $("#ledger").innerHTML = head + `<tbody>${body}</tbody>`;
    };
    if (LOG) return draw(LOG);
    fetch(`data/log.csv?v=${Math.floor(Date.now() / 600000)}`).then(r => r.text()).then(x => draw(d3.csvParse(x))).catch(() => draw([]));
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
    if (s && s.status === "ok") { renderHistory(s); renderBest(s); }
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
  Promise.all([fetch(`data/forecast.json${bust}`).then(r => r.json()), fetch(`data/evaluation.json${bust}`).then(r => r.json()),
    fetch("data/profiles.json").then(r => r.json()).catch(() => null)])
    .then(([f, e, p]) => {
      F = f; E = e; P = p;
      const st = Number(params.get("st"));
      if (st && station(st)) sel = st;
      if (!station(sel) || station(sel).status !== "ok") sel = (F.stations.find(s => s.status === "ok") || F.stations[0]).id;
      $("#status").hidden = true; $("#hero").hidden = false;
      renderAll();
      loadSchools();
    })
    .catch(err => { console.error(err); $("#status").textContent = t("error"); });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => null));
  }
})();
