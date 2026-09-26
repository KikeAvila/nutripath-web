/* NutriPath — app estilo Fitia (calorías, macros, IA de comida).
   Todo local-first: funciona offline con localStorage; sincroniza con Firebase
   (usuario+PIN) si hay red. La IA usa la API key de Anthropic del usuario. */

"use strict";

const KEY = "nutripath_state";
const MEALS = ["desayuno", "comida", "cena", "snack"];
const MEAL_LABEL = { desayuno: "Desayuno", comida: "Comida", cena: "Cena", snack: "Snack" };

let S = null;          // estado global
let curDate = hoyISO(); // día que se está viendo

// ---------- utilidades ----------
function hoyISO(d) { d = d || new Date(); return d.toISOString().slice(0, 10); }
function fmtDia(iso) {
  const hoy = hoyISO();
  if (iso === hoy) return "Hoy";
  const ayer = hoyISO(new Date(Date.now() - 864e5));
  if (iso === ayer) return "Ayer";
  const [y, m, dd] = iso.split("-");
  return `${dd}/${m}`;
}
function round(n, d) { const p = Math.pow(10, d || 0); return Math.round((+n || 0) * p) / p; }
function $(id) { return document.getElementById(id); }
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
}

// ---------- estado ----------
function nuevoEstado() {
  return {
    perfil: { nombre: "", pin: "", sexo: "h", edad: null, altura: null, peso: null, actividad: 1.55, objetivo: "perder" },
    plan: null,        // {tdee,kcal,prot,carb,fat}
    dias: {},          // iso -> {comidas:{...}, ejercicio:[]}
    pesos: {},         // iso -> kg
    porciones: {},     // nombreLower -> gramos habituales (última porción usada)
    recientes: [],     // alimentos usados recientemente (per 100 g), el más nuevo primero
    cloudTs: 0,
  };
}
function loadState() {
  try { S = JSON.parse(localStorage.getItem(KEY)) || nuevoEstado(); }
  catch (_) { S = nuevoEstado(); }
  S.perfil = Object.assign(nuevoEstado().perfil, S.perfil || {});
  S.dias = S.dias || {}; S.pesos = S.pesos || {};
  S.porciones = S.porciones || {}; S.recientes = S.recientes || [];
}
// gramos a proponer: prioriza la cantidad/porción escrita; si no, tu porción
// habitual recordada para ese alimento; si no, la estimación por defecto.
function gramosPara(parsed, nombre) {
  if (parsed.qty == null && parsed.porcG == null) {
    const r = S.porciones[(nombre || "").toLowerCase()];
    if (r) return r;
  }
  return gramosEstimados(parsed, nombre);
}
function recordarPorcion(food, g) {
  S.porciones[food.n.toLowerCase()] = g;
  S.recientes = S.recientes.filter((f) => f.n.toLowerCase() !== food.n.toLowerCase());
  S.recientes.unshift({ n: food.n, kcal: food.kcal, p: food.p, c: food.c, f: food.f, marca: food.marca || "" });
  S.recientes = S.recientes.slice(0, 12);
}
function saveState() {
  localStorage.setItem(KEY, JSON.stringify(S));
  cloudGuardar();
}
function diaActual() {
  if (!S.dias[curDate]) S.dias[curDate] = { comidas: { desayuno: [], comida: [], cena: [], snack: [] }, ejercicio: [] };
  const d = S.dias[curDate];
  d.comidas = d.comidas || { desayuno: [], comida: [], cena: [], snack: [] };
  MEALS.forEach((m) => { d.comidas[m] = d.comidas[m] || []; });
  d.ejercicio = d.ejercicio || [];
  return d;
}

// ---------- cálculo TDEE / plan ----------
function calcularPlan(p) {
  const kg = +p.peso, cm = +p.altura, edad = +p.edad;
  if (!kg || !cm || !edad) return null;
  // Mifflin-St Jeor
  let bmr = 10 * kg + 6.25 * cm - 5 * edad + (p.sexo === "h" ? 5 : -161);
  const tdee = bmr * (+p.actividad || 1.55);
  const ajuste = { perder_r: -500, perder: -300, mantener: 0, ganar: 300, ganar_r: 500 }[p.objetivo] || 0;
  let kcal = Math.max(1200, Math.round((tdee + ajuste) / 10) * 10);
  // Macros: proteína 2.0 g/kg, grasa 1.0 g/kg, resto carbohidratos
  const prot = Math.round(2.0 * kg);
  const fat = Math.round(1.0 * kg);
  const carb = Math.max(0, Math.round((kcal - prot * 4 - fat * 9) / 4));
  const imc = round(kg / Math.pow(cm / 100, 2), 1);
  return { tdee: Math.round(tdee), kcal, prot, carb, fat, imc };
}

// ---------- totales del día ----------
function totalesDia() {
  const d = diaActual();
  const t = { kcal: 0, p: 0, c: 0, f: 0, ej: 0 };
  MEALS.forEach((m) => d.comidas[m].forEach((it) => {
    t.kcal += +it.kcal || 0; t.p += +it.p || 0; t.c += +it.c || 0; t.f += +it.f || 0;
  }));
  d.ejercicio.forEach((e) => { t.ej += +e.kcal || 0; });
  return t;
}

// ---------- render diario ----------
function renderDiario() {
  $("day-label").textContent = fmtDia(curDate);
  const plan = S.plan || {};
  const t = totalesDia();
  const objetivo = plan.kcal || 0;
  const restantes = Math.round(objetivo + t.ej - t.kcal);

  $("kcal-left").textContent = objetivo ? restantes : "—";
  $("sum-goal").textContent = objetivo ? objetivo + " kcal" : "— kcal";
  $("sum-eaten").textContent = Math.round(t.kcal) + " kcal";
  $("sum-exercise").textContent = Math.round(t.ej) + " kcal";

  // anillo
  const frac = objetivo ? Math.min(1, t.kcal / (objetivo + t.ej)) : 0;
  const dash = 327; $("ring-fg").style.strokeDashoffset = dash * (1 - frac);
  $("ring-fg").style.stroke = (objetivo && t.kcal > objetivo + t.ej) ? "var(--danger)" : "var(--brand)";

  // macros
  setMacro("prot", t.p, plan.prot); setMacro("carb", t.c, plan.carb); setMacro("fat", t.f, plan.fat);

  // comidas
  const cont = $("meals"); cont.innerHTML = "";
  MEALS.forEach((m) => {
    const items = diaActual().comidas[m];
    const kcalM = Math.round(items.reduce((a, it) => a + (+it.kcal || 0), 0));
    const div = document.createElement("div");
    div.className = "meal";
    let html = `<div class="meal-head"><span>${MEAL_LABEL[m]} <span class="mk">${kcalM} kcal</span></span>
      <button class="meal-add" data-meal="${m}">+</button></div>`;
    if (!items.length) html += `<div class="meal-empty">Sin alimentos</div>`;
    items.forEach((it, i) => {
      html += `<div class="item"><div class="it-main"><span class="it-name">${esc(it.n)}</span>
        <span class="it-sub">${round(it.g, 0)} g · P${round(it.p, 0)} C${round(it.c, 0)} G${round(it.f, 0)}</span></div>
        <div style="display:flex;align-items:center"><span class="it-kcal">${round(it.kcal, 0)}</span>
        <button class="it-del" data-meal="${m}" data-i="${i}">🗑️</button></div></div>`;
    });
    // ejercicio como bloque final
    div.innerHTML = html;
    cont.appendChild(div);
  });
  // bloque ejercicio
  const ej = diaActual().ejercicio;
  if (ej.length) {
    const div = document.createElement("div"); div.className = "meal";
    let html = `<div class="meal-head"><span>🔥 Ejercicio <span class="mk">−${Math.round(t.ej)} kcal</span></span></div>`;
    ej.forEach((e, i) => {
      const sub = [e.min ? e.min + " min" : "", e.tipo && e.tipo !== e.n ? e.tipo : ""].filter(Boolean).join(" · ");
      html += `<div class="item"><div class="it-main"><span class="it-name">${esc(e.n || "Ejercicio")}</span>
        ${sub ? `<span class="it-sub">${esc(sub)}</span>` : ""}</div>
        <div style="display:flex;align-items:center"><span class="it-kcal">−${round(e.kcal, 0)}</span>
        <button class="it-del" data-ej="${i}">🗑️</button></div></div>`;
    });
    div.innerHTML = html; cont.appendChild(div);
  }

  cont.querySelectorAll(".meal-add").forEach((b) => b.onclick = () => abrirBuscar(b.dataset.meal));
  cont.querySelectorAll(".it-del[data-meal]").forEach((b) => b.onclick = () => {
    diaActual().comidas[b.dataset.meal].splice(+b.dataset.i, 1); saveState(); renderDiario();
  });
  cont.querySelectorAll(".it-del[data-ej]").forEach((b) => b.onclick = () => {
    diaActual().ejercicio.splice(+b.dataset.ej, 1); saveState(); renderDiario();
  });
}
function setMacro(k, val, goal) {
  $("m-" + k).textContent = round(val, 0);
  $("m-" + k + "-goal").textContent = goal || 0;
  $("bar-" + k).style.width = goal ? Math.min(100, (val / goal) * 100) + "%" : "0%";
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ================= PERFIL =================
function renderPerfil() {
  const p = S.perfil;
  $("p-nombre").value = p.nombre || ""; $("p-pin").value = p.pin || "";
  $("p-sexo").value = p.sexo || "h"; $("p-edad").value = p.edad || "";
  $("p-altura").value = p.altura || ""; $("p-peso").value = p.peso || "";
  $("p-actividad").value = String(p.actividad || 1.55); $("p-objetivo").value = p.objetivo || "perder";
  if (S.plan) mostrarPlan(S.plan, p);
}
function guardarPerfil() {
  const p = S.perfil;
  p.nombre = $("p-nombre").value.trim(); p.pin = $("p-pin").value.trim();
  p.sexo = $("p-sexo").value; p.edad = +$("p-edad").value || null;
  p.altura = +$("p-altura").value || null; p.peso = +$("p-peso").value || null;
  p.actividad = +$("p-actividad").value; p.objetivo = $("p-objetivo").value;
  const plan = calcularPlan(p);
  if (!plan) { toast("Completa edad, altura y peso"); return; }
  S.plan = plan;
  if (p.peso) S.pesos[hoyISO()] = p.peso;
  saveState(); mostrarPlan(plan, p); renderDiario();
  toast("Plan actualizado ✅");
  if (cloudReady() && p.nombre && /^\d{4}$/.test(p.pin)) cloudLogin(p.nombre, p.pin);
  actualizarEstadoNube();
}
function mostrarPlan(plan, p) {
  $("perfil-resultado").classList.remove("hidden");
  $("r-tdee").textContent = plan.tdee; $("r-kcal").textContent = plan.kcal;
  $("r-prot").textContent = plan.prot; $("r-carb").textContent = plan.carb;
  $("r-fat").textContent = plan.fat; $("r-imc").textContent = plan.imc;
  const obj = { perder_r: "déficit fuerte (~0,7 kg/sem)", perder: "déficit moderado (~0,3 kg/sem)", mantener: "mantenimiento", ganar: "superávit moderado", ganar_r: "superávit fuerte" }[p.objetivo];
  let imcTxt = plan.imc < 18.5 ? "bajo peso" : plan.imc < 25 ? "peso normal" : plan.imc < 30 ? "sobrepeso" : "obesidad";
  $("r-nota").textContent = `Objetivo: ${obj}. IMC ${plan.imc} (${imcTxt}). Estos valores son una guía; ajústalos con tu progreso real.`;
}

// ================= BUSCAR / AÑADIR con autocompletado y porciones =================
let buscarMeal = "comida";
function mealPorHora() { const h = new Date().getHours(); return h < 11 ? "desayuno" : h < 16 ? "comida" : h < 21.5 ? "cena" : "snack"; }

function abrirBuscar(meal) {
  buscarMeal = meal || mealPorHora();
  $("buscar-title").textContent = "Añadir a " + MEAL_LABEL[buscarMeal];
  $("buscar-input").value = ""; $("buscar-results").innerHTML = "";
  abrir("modal-buscar");
  setTimeout(() => $("buscar-input").focus(), 100);
  buscarLive();
}

// cantidades y porciones para el parser de texto
const CANT = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, medio: 0.5, media: 0.5 };
const PORC = { plato: 220, platos: 220, taza: 200, tazas: 200, vaso: 200, vasos: 200, cucharada: 15, cucharadas: 15, cucharadita: 5, cucharaditas: 5, punado: 30, punados: 30, "puñado": 30, "puñados": 30, loncha: 20, lonchas: 20, rebanada: 30, rebanadas: 30, filete: 120, filetes: 120, rodaja: 30, rodajas: 30, racion: 180, raciones: 180, "ración": 180, lata: 80, latas: 80, bol: 250 };
// peso por unidad para "2 huevos", "una manzana"...
const UNID = [["huevo", 60], ["manzana", 180], ["platano", 120], ["plátano", 120], ["banana", 120], ["naranja", 180], ["pera", 170], ["kiwi", 75], ["mandarina", 70], ["yogur", 125], ["tomate", 120], ["zanahoria", 80], ["galleta", 8], ["croqueta", 30], ["tortita", 15], ["magdalena", 40]];

function parseTexto(q) {
  let s = q.toLowerCase().trim().replace(/,/g, ".");
  let qty = null, porcG = null;
  // cantidad al inicio (número o palabra)
  let m = s.match(/^(\d+(?:\.\d+)?)\s+/);
  if (m) { qty = parseFloat(m[1]); s = s.slice(m[0].length); }
  else { m = s.match(/^([a-záéíóú]+)\s+/); if (m && CANT[m[1]] != null) { qty = CANT[m[1]]; s = s.slice(m[0].length); } }
  // palabra de porción
  m = s.match(/^([a-záéíóú]+)\s+/);
  if (m && PORC[m[1]] != null) { porcG = PORC[m[1]]; s = s.slice(m[0].length); }
  // quita "de" tras cantidad/porción
  s = s.replace(/^de\s+/, "").trim();
  return { qty, porcG, food: s || q.toLowerCase().trim() };
}
function gramosEstimados(parsed, foodNombre) {
  const { qty, porcG } = parsed;
  if (porcG != null) return Math.round((qty || 1) * porcG);
  if (qty != null) {
    const hit = UNID.find(([k]) => (foodNombre || parsed.food).toLowerCase().includes(k));
    if (hit) return Math.round(qty * hit[1]);
    return Math.round(qty * 100); // sin unidad conocida: qty × 100 g
  }
  return 100;
}

// filtra la base local
function buscarLocal(txt) {
  const q = txt.toLowerCase().trim(); if (!q) return [];
  const toks = q.split(/\s+/);
  const foods = window.FOODS_ES || [];
  const scored = [];
  foods.forEach((f) => {
    const hay = (f.n + " " + (f.g || []).join(" ")).toLowerCase();
    let score = 0;
    toks.forEach((tk) => { if (hay.includes(tk)) score += hay.startsWith(tk) ? 3 : 1; });
    if (score) scored.push({ f, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((x) => x.f);
}

let buscarTimer = null;
function buscarLive() {
  const q = $("buscar-input").value.trim();
  const cont = $("buscar-results");
  if (!q) { renderRecientes(); return; }
  const parsed = parseTexto(q);
  const locales = buscarLocal(parsed.food);
  let html = "";
  // pista de porción detectada
  if (parsed.qty != null || parsed.porcG != null) {
    const g = gramosEstimados(parsed, locales[0] && locales[0].n);
    html += `<div class="res hint"><div class="r-main"><span class="r-sub">📏 Detectado: ~${g} g${parsed.porcG ? " (porción)" : ""}. Se rellenará solo.</span></div></div>`;
  }
  // resultados locales
  locales.forEach((f, i) => {
    const g = gramosPara(parsed, f.n);
    const hab = S.porciones[f.n.toLowerCase()] && parsed.qty == null && parsed.porcG == null ? " ⭐" : "";
    const kcal = round(f.kcal * g / 100, 0);
    html += resHTML(i, f.n + hab, `${g} g · P${round(f.p * g / 100, 0)} C${round(f.c * g / 100, 0)} G${round(f.f * g / 100, 0)}`, kcal, "loc");
  });
  // opción IA por texto (platos compuestos / lo que sea)
  if (q.length > 2 && localStorage.getItem("np_key")) {
    html += `<div class="res ai" data-ia="1"><div class="r-main"><span class="r-name">🤖 Calcular “${esc(q)}” con IA</span>
      <span class="r-sub">Estima la porción y las calorías del plato descrito</span></div><span class="r-kcal">IA</span></div>`;
  }
  html += `<div class="res hint" id="off-loading"><div class="r-main"><span class="r-sub">Buscando productos…</span></div></div>`;
  cont.innerHTML = html;

  // enganchar clics locales
  locales.forEach((f, i) => {
    const el = cont.querySelector(`[data-loc="${i}"]`);
    if (el) el.onclick = () => abrirPorcion(f, gramosPara(parsed, f.n));
  });
  const iaEl = cont.querySelector("[data-ia]");
  if (iaEl) iaEl.onclick = () => estimarTextoIA(q);

  // Open Food Facts (debounce)
  clearTimeout(buscarTimer);
  buscarTimer = setTimeout(() => buscarOFF(parsed.food, parsed), 450);
}
function renderRecientes() {
  const cont = $("buscar-results");
  if (!S.recientes.length) {
    cont.innerHTML = `<div class="res hint"><div class="r-main"><span class="r-sub">Escribe un alimento. Ej: “2 huevos”, “un plato de arroz”, “pechuga de pollo”. Se guardará tu porción habitual ⭐.</span></div></div>`;
    return;
  }
  let html = `<div class="res hint"><div class="r-main"><span class="r-sub">🕘 Recientes (tu porción habitual)</span></div></div>`;
  S.recientes.forEach((f, i) => {
    const g = S.porciones[f.n.toLowerCase()] || 100;
    html += resHTML(i, f.n, `${g} g · ${round(f.kcal * g / 100, 0)} kcal`, round(f.kcal * g / 100, 0), "rec");
  });
  cont.innerHTML = html;
  S.recientes.forEach((f, i) => {
    const el = cont.querySelector(`[data-rec="${i}"]`);
    if (el) el.onclick = () => abrirPorcion(f, S.porciones[f.n.toLowerCase()] || 100);
  });
}
function resHTML(idx, nombre, sub, kcal, tipo) {
  return `<div class="res" data-${tipo}="${idx}"><div class="r-main"><span class="r-name">${esc(nombre)}</span>
    <span class="r-sub">${esc(sub)}</span></div><span class="r-kcal">${kcal} kcal</span></div>`;
}

// ---------- Open Food Facts ----------
async function buscarOFF(txt, parsed) {
  const load = $("off-loading");
  try {
    const url = "https://world.openfoodfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(txt) +
      "&search_simple=1&action=process&json=1&page_size=6&fields=product_name,brands,nutriments,code";
    const r = await fetch(url); const data = await r.json();
    const prods = (data.products || []).map(offToFood).filter(Boolean);
    if (load) load.remove();
    if (!prods.length) return;
    const cont = $("buscar-results");
    prods.forEach((f, i) => {
      const g = gramosPara(parsed, f.n);
      const el = document.createElement("div");
      el.innerHTML = resHTML(i, f.n, `${f.marca ? f.marca + " · " : ""}${g} g`, round(f.kcal * g / 100, 0), "off");
      const node = el.firstChild;
      node.onclick = () => abrirPorcion(f, g);
      cont.appendChild(node);
    });
  } catch (_) { if (load) load.textContent = ""; }
}
function offToFood(p) {
  const n = p.nutriments || {};
  const kcal = +n["energy-kcal_100g"];
  if (!p.product_name || !kcal) return null;
  return {
    n: p.product_name, marca: (p.brands || "").split(",")[0], kcal,
    p: +n.proteins_100g || 0, c: +n.carbohydrates_100g || 0, f: +n.fat_100g || 0,
  };
}

// ================= MODAL PORCIÓN =================
let porcionFood = null;
function abrirPorcion(food, gramos) {
  porcionFood = food;
  cerrar("modal-buscar");
  $("porcion-nombre").textContent = food.n;
  $("porcion-gramos").value = gramos || 100;
  $("porcion-meal").value = buscarMeal;
  actualizarPreviewPorcion();
  abrir("modal-porcion");
}
function actualizarPreviewPorcion() {
  const g = +$("porcion-gramos").value || 0; const f = porcionFood;
  $("porcion-preview").innerHTML = `Para <b>${round(g, 0)} g</b>: <b>${round(f.kcal * g / 100, 0)} kcal</b> · ` +
    `Prot ${round(f.p * g / 100, 1)} g · Carb ${round(f.c * g / 100, 1)} g · Grasa ${round(f.f * g / 100, 1)} g`;
}
function confirmarPorcion() {
  const g = +$("porcion-gramos").value || 0; const f = porcionFood; if (!g) return;
  const meal = $("porcion-meal").value;
  diaActual().comidas[meal].push({
    n: f.n, g, kcal: round(f.kcal * g / 100, 1), p: round(f.p * g / 100, 1), c: round(f.c * g / 100, 1), f: round(f.f * g / 100, 1),
  });
  recordarPorcion(f, g); // recuerda esta porción como la habitual de este alimento
  saveState(); cerrar("modal-porcion"); renderDiario();
  toast(`Añadido a ${MEAL_LABEL[meal]} ✅`);
}

// ================= IA: TEXTO =================
async function estimarTextoIA(texto) {
  const cont = $("buscar-results");
  cont.innerHTML = `<div class="res hint"><div class="r-main"><span class="r-sub">🤖 Estimando “${esc(texto)}”…</span></div></div>`;
  try {
    const prompt = `Eres nutricionista. Estima los valores de esta comida en español: "${texto}". ` +
      `Si no se indica cantidad, usa una porción media típica española. ` +
      `Responde SOLO con JSON válido, sin texto extra ni markdown: ` +
      `{"nombre":"...","gramos":number,"kcal":number,"prot":number,"carb":number,"grasa":number}`;
    const txt = await llmText([{ role: "user", content: prompt }], 300);
    const j = extraerJSON(txt);
    if (!j || !j.kcal) throw new Error("sin datos");
    const g = +j.gramos || 100;
    const food = { n: j.nombre || texto, kcal: j.kcal * 100 / g, p: (j.prot || 0) * 100 / g, c: (j.carb || 0) * 100 / g, f: (j.grasa || 0) * 100 / g };
    abrirPorcion(food, g);
  } catch (e) {
    cont.innerHTML = `<div class="res hint"><div class="r-main"><span class="r-sub">No pude estimarlo (${esc(String(e.message || e))}). Revisa tu API key en Ajustes.</span></div></div>`;
  }
}

// ================= IA: FOTO =================
function abrirFoto() { $("foto-preview").classList.add("hidden"); $("foto-result").innerHTML = ""; $("foto-status").textContent = ""; abrir("modal-foto"); }
async function analizarFoto(file) {
  if (!localStorage.getItem("np_key")) { toast("Pon tu API key en Ajustes"); switchView("ajustes"); return; }
  const dataUrl = await leerImagen(file);
  $("foto-preview").src = dataUrl; $("foto-preview").classList.remove("hidden");
  $("foto-status").textContent = "🤖 Analizando la foto…"; $("foto-result").innerHTML = "";
  try {
    const b64 = dataUrl.split(",")[1];
    const media = (dataUrl.match(/data:(image\/[a-z]+);/) || [])[1] || "image/jpeg";
    const prompt = `Eres nutricionista. Identifica la comida de la foto y estima la porción visible. ` +
      `Responde SOLO con JSON válido, sin texto extra ni markdown: ` +
      `{"nombre":"...","gramos":number,"kcal":number,"prot":number,"carb":number,"grasa":number}. Usa porciones medias españolas.`;
    const txt = await llmText([{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: media, data: b64 } },
      { type: "text", text: prompt },
    ] }], 300);
    const j = extraerJSON(txt);
    if (!j || !j.kcal) throw new Error("no reconocida");
    $("foto-status").textContent = "";
    const g = +j.gramos || 100;
    const el = document.createElement("div");
    el.innerHTML = resHTML(0, j.nombre || "Comida", `~${g} g · P${round(j.prot, 0)} C${round(j.carb, 0)} G${round(j.grasa, 0)}`, round(j.kcal, 0), "fai");
    const node = el.firstChild;
    node.onclick = () => {
      const food = { n: j.nombre || "Comida", kcal: j.kcal * 100 / g, p: (j.prot || 0) * 100 / g, c: (j.carb || 0) * 100 / g, f: (j.grasa || 0) * 100 / g };
      cerrar("modal-foto"); abrirPorcion(food, g);
    };
    $("foto-result").appendChild(node);
    $("foto-result").insertAdjacentHTML("beforeend", `<p class="nota">Toca el resultado para añadirlo (podrás ajustar los gramos).</p>`);
  } catch (e) {
    $("foto-status").textContent = "No pude reconocer la comida (" + (e.message || e) + "). Prueba otra foto o revisa tu API key.";
  }
}
function leerImagen(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    const rd = new FileReader();
    rd.onload = () => {
      img.onload = () => {
        // reescala a máx 900px para no gastar tokens de más
        const max = 900; let { width: w, height: h } = img;
        if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        res(cv.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = rej; img.src = rd.result;
    };
    rd.onerror = rej; rd.readAsDataURL(file);
  });
}

// ================= LLAMADA A CLAUDE =================
async function llmText(messages, maxTokens) {
  const apiKey = localStorage.getItem("np_key");
  if (!apiKey) throw new Error("sin API key");
  const model = localStorage.getItem("np_model") || "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens || 300, messages }),
  });
  if (!res.ok) { const e = await res.text().catch(() => ""); throw new Error("API " + res.status + (res.status === 401 ? " (key inválida)" : "")); }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("");
}
function extraerJSON(txt) {
  if (!txt) return null;
  let s = txt.replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ================= CÓDIGO DE BARRAS =================
let barrasStream = null, barrasLoop = null;
function abrirBarras() { $("barras-status").textContent = ""; $("barras-input").value = ""; abrir("modal-barras"); }
async function escanearBarras() {
  if (!("BarcodeDetector" in window)) { $("barras-status").textContent = "Tu navegador no soporta el escáner. Escribe el código a mano."; return; }
  try {
    const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    barrasStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const v = $("barras-video"); v.srcObject = barrasStream; v.classList.remove("hidden"); await v.play();
    $("barras-status").textContent = "Apunta al código de barras…";
    barrasLoop = setInterval(async () => {
      try {
        const codes = await det.detect(v);
        if (codes && codes.length) { pararBarras(); buscarBarras(codes[0].rawValue); }
      } catch (_) {}
    }, 400);
  } catch (e) { $("barras-status").textContent = "No pude abrir la cámara. Escribe el código a mano."; }
}
function pararBarras() {
  clearInterval(barrasLoop);
  if (barrasStream) { barrasStream.getTracks().forEach((t) => t.stop()); barrasStream = null; }
  $("barras-video").classList.add("hidden");
}
async function buscarBarras(code) {
  $("barras-status").textContent = "Buscando " + code + "…";
  try {
    const r = await fetch("https://world.openfoodfacts.org/api/v2/product/" + encodeURIComponent(code) + ".json?fields=product_name,brands,nutriments");
    const data = await r.json();
    if (data.status !== 1 || !data.product) throw new Error("no encontrado");
    const f = offToFood(data.product);
    if (!f) throw new Error("sin datos nutricionales");
    cerrar("modal-barras"); abrirPorcion(f, 100);
  } catch (e) { $("barras-status").textContent = "Producto no encontrado (" + code + "). Prueba a buscarlo por nombre."; }
}

// ================= EJERCICIO =================
function abrirEjercicio() {
  $("ej-nombre").value = ""; $("ej-kcal").value = ""; $("ej-min").value = ""; $("ej-tipo").selectedIndex = 0;
  ejPreview(); abrir("modal-ejercicio");
}
// kcal ≈ MET × peso(kg) × horas  (fórmula estándar de gasto por actividad)
function ejCalcKcal() {
  const met = +$("ej-tipo").value || 4; const min = +$("ej-min").value || 0;
  const peso = +S.perfil.peso || 70;
  return Math.round(met * peso * (min / 60));
}
function ejPreview() {
  const auto = ejCalcKcal();
  if (auto > 0 && !$("ej-kcal").value) $("ej-kcal").value = auto; // rellena si el usuario no ha puesto nada
  const peso = +S.perfil.peso || 70;
  $("ej-preview").innerHTML = auto > 0
    ? `Estimado: <b>${auto} kcal</b> (con ${peso} kg). Puedes ajustarlo a mano.`
    : `Elige tipo y minutos y calculo las calorías (usa tu peso del perfil).`;
}
function addEjercicio() {
  const tipoTxt = $("ej-tipo").options[$("ej-tipo").selectedIndex].text.replace(/^[^\wÁÉÍÓÚ]+/, "").trim();
  const nota = $("ej-nombre").value.trim();
  const min = +$("ej-min").value || 0;
  const kcal = +$("ej-kcal").value || ejCalcKcal();
  if (!kcal) { toast("Pon minutos o las calorías"); return; }
  const n = nota || tipoTxt || "Ejercicio";
  diaActual().ejercicio.push({ n, kcal, min, nota, tipo: tipoTxt });
  saveState(); cerrar("modal-ejercicio"); renderDiario();
  toast("Ejercicio añadido 🔥");
}

// ================= PROGRESO (peso + gráficas) =================
function renderProgreso() {
  const isos = Object.keys(S.pesos).sort();
  dibujarLinea($("peso-chart"), isos.map((i) => S.pesos[i]), "kg");
  const st = $("peso-stats");
  if (isos.length >= 2) {
    const dif = round(S.pesos[isos[isos.length - 1]] - S.pesos[isos[0]], 1);
    st.textContent = `${isos.length} registros · ${dif > 0 ? "+" : ""}${dif} kg desde el inicio (${S.pesos[isos[0]]} → ${S.pesos[isos[isos.length - 1]]} kg)`;
  } else st.textContent = "Registra tu peso para ver la evolución.";
  // kcal últimos 7 días
  const dias = []; for (let i = 6; i >= 0; i--) dias.push(hoyISO(new Date(Date.now() - i * 864e5)));
  const vals = dias.map((iso) => {
    const d = S.dias[iso]; if (!d) return 0;
    let k = 0; MEALS.forEach((m) => (d.comidas[m] || []).forEach((it) => k += +it.kcal || 0)); return Math.round(k);
  });
  dibujarBarras($("kcal-chart"), vals, dias.map((i) => i.slice(8)), S.plan && S.plan.kcal);
}
function guardarPeso() {
  const kg = +$("peso-input").value; if (!kg) { toast("Escribe tu peso"); return; }
  S.pesos[hoyISO()] = kg; S.perfil.peso = kg;
  const plan = calcularPlan(S.perfil); if (plan) S.plan = plan;
  $("peso-input").value = ""; saveState(); renderProgreso(); renderDiario();
  toast("Peso guardado ⚖️");
}
function dibujarLinea(cv, vals, unidad) {
  const ctx = cv.getContext("2d"); const W = cv.width = cv.clientWidth, H = cv.height;
  ctx.clearRect(0, 0, W, H); if (vals.length < 1) return;
  const min = Math.min(...vals) - 1, max = Math.max(...vals) + 1, rng = max - min || 1;
  const pad = 24; const x = (i) => pad + (W - 2 * pad) * (vals.length === 1 ? 0.5 : i / (vals.length - 1));
  const y = (v) => H - pad - (H - 2 * pad) * (v - min) / rng;
  ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 2.5; ctx.beginPath();
  vals.forEach((v, i) => { i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); }); ctx.stroke();
  ctx.fillStyle = "#22c55e"; vals.forEach((v, i) => { ctx.beginPath(); ctx.arc(x(i), y(v), 3, 0, 7); ctx.fill(); });
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted"); ctx.font = "11px sans-serif";
  ctx.fillText(max.toFixed(1) + " " + unidad, 2, 12); ctx.fillText(min.toFixed(1), 2, H - 6);
}
function dibujarBarras(cv, vals, labels, goal) {
  const ctx = cv.getContext("2d"); const W = cv.width = cv.clientWidth, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(goal || 0, ...vals, 1) * 1.15; const pad = 22; const n = vals.length;
  const bw = (W - 2 * pad) / n * 0.6, gap = (W - 2 * pad) / n;
  if (goal) { const gy = H - pad - (H - 2 * pad) * goal / max; ctx.strokeStyle = "#e5484d"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - pad, gy); ctx.stroke(); ctx.setLineDash([]); }
  ctx.fillStyle = "#22c55e";
  vals.forEach((v, i) => {
    const h = (H - 2 * pad) * v / max; const bx = pad + gap * i + (gap - bw) / 2;
    ctx.fillRect(bx, H - pad - h, bw, h);
  });
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted"); ctx.font = "10px sans-serif"; ctx.textAlign = "center";
  labels.forEach((l, i) => ctx.fillText(l, pad + gap * i + gap / 2, H - 6)); ctx.textAlign = "left";
}

// ================= NUBE (Firebase) =================
let cloudDoc = null, cloudUnsub = null, cloudSaveTimer = null, cloudAplicando = false;
function cloudReady() { return typeof firebase !== "undefined" && !!window._db; }
function cloudKey(nombre) { return (nombre || "").trim().toLowerCase().replace(/[^\w-]+/g, "_"); }
function actualizarEstadoNube() {
  const el = $("cloud-state"); if (!el) return;
  if (cloudDoc) el.textContent = "Estado: sincronizado como " + S.perfil.nombre + " ☁️";
  else if (!cloudReady()) el.textContent = "Estado: solo local (sin conexión)";
  else el.textContent = "Estado: local — pon nombre y PIN en Perfil para sincronizar";
}
function aplicarNube(jsonStr, ts) {
  let data; try { data = JSON.parse(jsonStr); } catch (_) { return; }
  if (!data || !data.perfil) return;
  cloudAplicando = true;
  S = data; S.cloudTs = ts; S.dias = S.dias || {}; S.pesos = S.pesos || {};
  localStorage.setItem(KEY, JSON.stringify(S));
  renderPerfil(); renderDiario(); if ($("view-progreso").classList.contains("active")) renderProgreso();
  cloudAplicando = false; actualizarEstadoNube(); toast("Sincronizado ☁️");
}
function cloudGuardarYa() {
  if (!cloudReady() || !cloudDoc) return;
  S.cloudTs = Date.now();
  cloudDoc.set({ pin: (S.perfil && S.perfil.pin) || "", data: JSON.stringify(S), updatedAt: S.cloudTs })
    .catch((e) => console.warn("nube:", e));
}
function cloudGuardar() {
  if (!cloudReady() || !cloudDoc || cloudAplicando) return;
  clearTimeout(cloudSaveTimer); cloudSaveTimer = setTimeout(cloudGuardarYa, 800);
}
async function cloudLogin(nombre, pin) {
  if (!cloudReady()) return false;
  const key = cloudKey(nombre); if (!key || !/^\d{4}$/.test(pin || "")) return false;
  try {
    if (cloudUnsub) { cloudUnsub(); cloudUnsub = null; }
    cloudDoc = window._db.collection("salud_usuarios").doc(key);
    const snap = await cloudDoc.get();
    if (snap.exists) {
      const d = snap.data() || {};
      if ((d.pin || "") !== pin) { toast("Ese usuario ya existe con otro PIN"); cloudDoc = null; return false; }
      const remoteTs = d.updatedAt || 0, localTs = S.cloudTs || 0;
      if (remoteTs > localTs && d.data) aplicarNube(d.data, remoteTs); else cloudGuardarYa();
    } else cloudGuardarYa();
    cloudUnsub = cloudDoc.onSnapshot((s) => {
      if (!s.exists) return; const d = s.data() || {};
      if ((d.updatedAt || 0) > (S.cloudTs || 0) && d.data) aplicarNube(d.data, d.updatedAt);
    });
    actualizarEstadoNube(); return true;
  } catch (e) { console.warn("cloudLogin:", e); return false; }
}

// ================= NAVEGACIÓN / MODALES =================
function switchView(v) {
  document.querySelectorAll(".view").forEach((s) => s.classList.remove("active"));
  $("view-" + v).classList.add("active");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  if (v === "progreso") renderProgreso();
  if (v === "perfil") renderPerfil();
  if (v === "ajustes") actualizarEstadoNube();
  window.scrollTo(0, 0);
}
function abrir(id) { $(id).classList.remove("hidden"); }
function cerrar(id) { $(id).classList.add("hidden"); if (id === "modal-barras") pararBarras(); }

// ================= TEMA =================
function setTheme(t) { document.body.setAttribute("data-theme", t); localStorage.setItem("np_theme", t); $("theme-toggle").textContent = t === "dark" ? "☀️" : "🌙"; }
function toggleTheme() { setTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark"); }

// ================= INIT =================
function init() {
  loadState();
  setTheme(localStorage.getItem("np_theme") || "light");
  renderPerfil(); renderDiario();

  // nav
  document.querySelectorAll(".tab").forEach((t) => t.onclick = () => switchView(t.dataset.view));
  document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => cerrar(b.dataset.close));
  $("theme-toggle").onclick = toggleTheme;

  // día
  $("day-prev").onclick = () => { curDate = hoyISO(new Date(new Date(curDate) - 864e5)); renderDiario(); };
  $("day-next").onclick = () => { const n = new Date(new Date(curDate).getTime() + 864e5); if (hoyISO(n) <= hoyISO()) { curDate = hoyISO(n); renderDiario(); } };

  // quick actions
  document.querySelectorAll(".qa").forEach((b) => b.onclick = () => {
    const a = b.dataset.add;
    if (a === "buscar") abrirBuscar();
    else if (a === "foto") abrirFoto();
    else if (a === "barras") abrirBarras();
    else if (a === "ejercicio") abrirEjercicio();
  });

  // buscar
  $("buscar-input").addEventListener("input", buscarLive);
  // porción
  $("porcion-gramos").addEventListener("input", actualizarPreviewPorcion);
  $("porcion-add").onclick = confirmarPorcion;
  // foto
  $("foto-pick").onclick = () => $("foto-input").click();
  $("foto-input").addEventListener("change", (e) => { if (e.target.files[0]) analizarFoto(e.target.files[0]); });
  // barras
  $("barras-scan").onclick = escanearBarras;
  $("barras-go").onclick = () => { const c = $("barras-input").value.trim(); if (c) buscarBarras(c); };
  // ejercicio
  $("ej-add").onclick = addEjercicio;
  $("ej-tipo").addEventListener("change", () => { $("ej-kcal").value = ""; ejPreview(); });
  $("ej-min").addEventListener("input", () => { $("ej-kcal").value = ""; ejPreview(); });

  // perfil
  $("p-guardar").onclick = guardarPerfil;
  // progreso
  $("peso-save").onclick = guardarPeso;

  // ajustes
  const keyIn = $("a-key"), modelSel = $("a-model");
  if (localStorage.getItem("np_key")) { keyIn.placeholder = "•••• guardada ••••"; $("a-key-state").textContent = "API key guardada en este dispositivo ✅"; }
  modelSel.value = localStorage.getItem("np_model") || "claude-sonnet-4-6";
  $("a-key-save").onclick = () => {
    const k = keyIn.value.trim(); if (k) localStorage.setItem("np_key", k);
    localStorage.setItem("np_model", modelSel.value);
    keyIn.value = ""; keyIn.placeholder = "•••• guardada ••••";
    $("a-key-state").textContent = "Guardado ✅"; toast("IA configurada");
  };
  modelSel.onchange = () => localStorage.setItem("np_model", modelSel.value);
  $("export-data").onclick = () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "nutripath-datos.json"; a.click();
  };
  $("reset-day").onclick = () => { if (confirm("¿Borrar todo lo del día " + fmtDia(curDate) + "?")) { delete S.dias[curDate]; saveState(); renderDiario(); toast("Día borrado"); } };

  // login nube si ya hay perfil
  if (S.perfil.nombre && /^\d{4}$/.test(S.perfil.pin || "")) cloudLogin(S.perfil.nombre, S.perfil.pin);
  actualizarEstadoNube();

  // service worker
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js?v=1").catch(() => {});
}

document.addEventListener("DOMContentLoaded", init);
