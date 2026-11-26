// ══════════════════════════════════════════════════════════════
//  mtto-chatbot · Supabase Edge Function  (versión con consultas a la app)
//  El asistente sabe quién está conectado y consulta los datos de la app con
//  "herramientas" (function calling de Google Gemini):
//    · preventivos   → órdenes de equipos, inspecciones locativas y agua purificada
//    · solicitudes_mantenimiento
//    · bitacora      → reportes de turno, realizadas y pendientes
//    · almacen       → artículos e inventario
//    · solicitudes_material
//    · historial     → quién hizo qué en la app
//    · buscar_en_internet → solo para dudas técnicas que no están en la app
//  Gemini decide qué consultar, recibe los datos y responde citando el módulo.
// ══════════════════════════════════════════════════════════════

const SUPA_URL = "https://mysqkhttdquwicrsjcmg.supabase.co";
// Misma anon key pública que ya usa el resto de la app (protegida por RLS).
const SUPA_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15c3FraHR0ZHF1d2ljcnNqY21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0OTAxMzMsImV4cCI6MjA5MzA2NjEzM30.RBw3DwjQZvoJUhqBIkR6p3LdYhpc3PVMcyZiIe0uGUE";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Si el modelo deja de existir, el error de la API dice cuál usar (https://ai.google.dev/gemini-api/docs/models)
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";
// Modelo de respaldo opcional (secreto GEMINI_MODEL_RESPALDO) para cuando el principal está saturado
const MODEL_RESPALDO = Deno.env.get("GEMINI_MODEL_RESPALDO") ?? "";
const urlModelo = (m: string) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const GEMINI_URL = urlModelo(MODEL);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Gemini a veces responde 503 ("high demand") o 429 (cupo por minuto): se reintenta solo con pausas cortas
async function fetchGemini(cuerpo: unknown): Promise<Response> {
  const modelos = [MODEL, MODEL_RESPALDO].filter(Boolean);
  let ultima: Response | null = null;
  for (const m of modelos) {
    for (let intento = 0; intento < 3; intento++) {
      const r = await fetch(`${urlModelo(m)}?key=${GEMINI_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo),
      });
      if (r.status !== 503 && r.status !== 429 && r.status !== 500) return r;
      ultima = r;
      await esperar(800 * Math.pow(2, intento));   // 0,8 s · 1,6 s · 3,2 s
    }
  }
  return ultima!;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

// ── utilidades ─────────────────────────────────────────────────
function norm(s: unknown) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
// "M12 · Pablo Fonseca (x)" → "pablo fonseca"
function normPersona(s: unknown) {
  const t = String(s ?? "");
  return norm(t.includes("·") ? t.split("·").pop() : t).replace(/\(.*?\)/g, "").trim();
}
function coincidePersona(valor: unknown, buscado?: string) {
  if (!buscado) return true;
  const v = normPersona(valor), b = normPersona(buscado);
  if (!v || !b) return false;
  if (v.includes(b) || b.includes(v)) return true;
  // "cesar" encuentra "cesar pacheco"; "pacheco" también
  return b.split(" ").every((p) => v.split(" ").some((w) => w.startsWith(p)));
}
function contiene(blob: unknown, texto?: string) {
  if (!texto) return true;
  const b = norm(blob);
  return norm(texto).split(" ").filter((w) => w.length >= 3).every((w) => b.includes(w));
}
function hoyBogota() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }));
}
function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function rest(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let desde = 0; desde < 20000; desde += 1000) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPA_ANON_KEY, Authorization: `Bearer ${SUPA_ANON_KEY}`, Range: `${desde}-${desde + 999}` },
    });
    if (!r.ok) break;
    const d = await r.json().catch(() => []);
    if (!Array.isArray(d)) break;
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}
function limitar<T>(arr: T[], n = 60) {
  return { total: arr.length, mostrando: Math.min(arr.length, n), items: arr.slice(0, n) };
}
const yo = (v: unknown, usuario: any) => (v === "yo" ? (usuario?.nombre || usuario?.username || "") : String(v ?? ""));

// ── herramientas ───────────────────────────────────────────────
async function tPreventivos(a: any, usuario: any) {
  const hoy = hoyBogota();
  const anio = Number(a.anio) || hoy.getFullYear();
  const mes = a.mes ? Number(a.mes) : null;
  const tecnico = a.tecnico === "todos" ? "" : (a.tecnico ? yo(a.tecnico, usuario) : (usuario?.nombre || ""));
  const estado = a.estado || "todos";
  const tipo = a.tipo || "todos";
  const filas: any[] = [];
  const mesDe = (o: any) => o.mes_reprogramado || o.mes;
  const ok = (o: any) => o.estado !== "rechazada" && (!mes || mesDe(o) === mes) && coincidePersona(o.asignado_a, tecnico) &&
    (estado === "todos" || (estado === "hechos" ? o.estado === "ejecutado" : o.estado !== "ejecutado"));
  if (tipo === "todos" || tipo === "equipos") {
    (await rest(`mtto_ordenes?select=*&anio=eq.${anio}&order=mes`)).filter(ok).forEach((o) => filas.push({
      tipo: "equipo", mes: MESES[mesDe(o) - 1], codigo: o.equipo_codigo, nombre: o.equipo_desc, consecutivo: o.consecutivo,
      frecuencia: o.frecuencia, estado: o.estado, asignado_a: o.asignado_a || "sin asignar", ejecutado: o.fecha_ejecucion || undefined }));
  }
  if (tipo === "todos" || tipo === "inspecciones") {
    (await rest(`mtto_inspecciones?select=*&anio=eq.${anio}&order=mes`)).filter(ok).forEach((o) => filas.push({
      tipo: "inspección locativa", mes: MESES[mesDe(o) - 1], area: o.area_nombre, consecutivo: o.consecutivo,
      esclusas: [o.esclusa_c41 && o.esclusa_c41 !== o.area_nombre ? o.esclusa_c41 : null, o.esclusa_c56].filter(Boolean).join(", ") || undefined,
      estado: o.estado, asignado_a: o.asignado_a || "sin asignar", ejecutado: o.fecha_ejecucion || undefined }));
  }
  if (tipo === "todos" || tipo === "agua") {
    (await rest(`mtto_agua?select=*&anio=eq.${anio}&order=mes`)).filter(ok).forEach((o) => filas.push({
      tipo: "agua purificada", mes: MESES[mesDe(o) - 1], sistema: o.sistema, actividad: o.actividad, semana: o.semana,
      frecuencia: o.frecuencia, estado: o.estado, asignado_a: o.asignado_a || "sin asignar", ejecutado: o.fecha_ejecucion || undefined }));
  }
  const hechos = filas.filter((f) => f.estado === "ejecutado").length;
  return { filtro: { anio, mes: mes ? MESES[mes - 1] : "todo el año", tecnico: tecnico || "todos", estado, tipo },
    hechos, pendientes: filas.length - hechos, ...limitar(filas, 80) };
}

async function tSolicitudesMtto(a: any, usuario: any) {
  const tecnico = !a.tecnico || a.tecnico === "todos" ? "" : yo(a.tecnico, usuario);
  const estado = a.estado || "pendientes";
  let filas = await rest(`solicitudes_mantenimiento?select=*&order=enviado_en.desc`);
  filas = filas.filter((s) =>
    (estado === "todas" || (estado === "pendientes" ? (s.estado === "abierta" || s.estado === "asignada") : s.estado === estado)) &&
    coincidePersona(s.asignado_a, tecnico) &&
    (!a.solicitante || coincidePersona(s.solicitante, yo(a.solicitante, usuario))) &&
    contiene([s.area_nombre, s.item_nombre, s.descripcion, s.consecutivo].join(" "), a.texto));
  return { filtro: { estado, tecnico: tecnico || "todos" }, ...limitar(filas.map((s) => ({
    consecutivo: s.consecutivo, area: s.area_nombre, item: s.item_nombre, descripcion: s.descripcion, estado: s.estado,
    asignado_a: s.asignado_a || "sin asignar", solicitante: s.solicitante, enviada: String(s.enviado_en || "").slice(0, 10),
    fecha_estimada: s.fecha_estimada || undefined })), 50) };
}

async function tBitacora(a: any, usuario: any) {
  const r = await rest(`bitacora_kv?select=value&key=eq.btk_v1`);
  const entries: any[] = r.length && Array.isArray(r[0].value) ? r[0].value : [];
  const desde = a.desde || "0000-00-00", hasta = a.hasta || "9999-99-99";
  const tecnico = a.tecnico ? yo(a.tecnico, usuario) : "";
  const filas = entries.filter((e) => {
    const f = String(e.fecha || e.createdAt || "").slice(0, 10);
    if (f < desde || f > hasta) return false;
    if (tecnico && !coincidePersona(e.tecnico, tecnico)) return false;
    if (a.turno && !contiene(e.turno, a.turno)) return false;
    if (a.solo_pendientes_abiertos && !(e.pendientes || []).some((p: any) => !p.cerrado)) return false;
    if (a.texto && !contiene(JSON.stringify([e.realizadas, e.pendientes, e.obs]), a.texto)) return false;
    return true;
  }).sort((x, y) => String(y.fecha || y.createdAt).localeCompare(String(x.fecha || x.createdAt)))
    .map((e) => ({
      fecha: e.fecha, turno: e.turno, tecnico: String(e.tecnico || "").split("·").pop()!.trim(), tipo: e.tipo,
      realizadas: (e.realizadas || []).map((x: any) => `${x.hi || ""}${x.hf ? "-" + x.hf : ""} ${x.area || ""}: ${x.desc || ""}`.trim()),
      pendientes: (e.pendientes || []).map((p: any) => `${p.area || p.equipo || ""}: ${p.desc || ""} [${p.p || "Media"}${p.cerrado ? ", cerrado" : ", abierto"}${(p.seguimientos || []).length ? ", " + p.seguimientos.length + " seguimientos" : ""}]`),
      observaciones: e.obs || undefined,
    }));
  return { filtro: { desde: a.desde, hasta: a.hasta, tecnico: tecnico || undefined, turno: a.turno, texto: a.texto },
    nota: "Los reportes viejos que se archivaron no se consultan aquí (están en el Archivo de la Bitácora).", ...limitar(filas, 25) };
}

async function tAlmacen(a: any) {
  let filas = await rest(`articulos?select=code,name,category,quantity,min_stock,unit,location`);
  filas = filas.filter((x) => contiene([x.code, x.name, x.category, x.location].join(" "), a.texto) &&
    (!a.solo_bajo_stock || Number(x.quantity) <= Number(x.min_stock || 0)));
  filas.sort((x, y) => String(x.name).localeCompare(String(y.name)));
  return limitar(filas, 60);
}

async function tSolicitudesMaterial(a: any, usuario: any) {
  let filas = await rest(`solicitudes?select=*&order=created_at.desc`);
  filas = filas.filter((s) =>
    (!a.estado || norm(s.status).includes(norm(a.estado))) &&
    (!a.solicitante || coincidePersona(s.solicitante_name || s.solicitante, yo(a.solicitante, usuario))) &&
    contiene([s.item_name, s.item_code, s.reason, s.equipo_name, s.consecutivo].join(" "), a.texto));
  return limitar(filas.map((s) => ({ consecutivo: s.consecutivo, articulo: s.item_name, codigo: s.item_code, cantidad: s.quantity,
    unidad: s.unidad || s.unit, estado: s.status, motivo: s.reason, solicitante: s.solicitante_name || s.solicitante,
    equipo: s.equipo_name || undefined, fecha: String(s.created_at || "").slice(0, 10) })), 50);
}

async function tHistorial(a: any, usuario: any) {
  const desde = a.desde ? `&created_at=gte.${a.desde}` : "";
  let filas = await rest(`movimientos?select=type,item_name,item_code,quantity,usuario,notes,created_at&order=created_at.desc${desde}`);
  filas = filas.filter((m) => contiene([m.type, m.item_name, m.item_code, m.notes].join(" "), a.texto) &&
    (!a.usuario || coincidePersona(m.usuario, yo(a.usuario, usuario))));
  return limitar(filas.map((m) => ({ tipo: m.type, que: m.item_name, codigo: m.item_code || undefined, cantidad: m.quantity || undefined,
    usuario: m.usuario, nota: m.notes || undefined, cuando: String(m.created_at || "").slice(0, 16).replace("T", " ") })), 40);
}

async function tInternet(a: any) {
  const r = await fetchGemini({
    contents: [{ role: "user", parts: [{ text: String(a.pregunta || "") }] }],
    systemInstruction: { parts: [{ text: "Responde breve y práctico para un técnico de mantenimiento industrial. Cita las fuentes web con su URL." }] },
    tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 800 },
  });
  if (!r.ok) return { error: "La búsqueda web no está disponible ahora (" + r.status + ")." };
  const d = await r.json();
  return { respuesta: (d?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || "").join("\n") };
}

const HERRAMIENTAS: Record<string, (a: any, u: any) => Promise<any>> = {
  preventivos: tPreventivos, solicitudes_mantenimiento: tSolicitudesMtto, bitacora: tBitacora,
  almacen: tAlmacen, solicitudes_material: tSolicitudesMaterial, historial: tHistorial, buscar_en_internet: tInternet,
};

const S = (description: string) => ({ type: "STRING", description });
const DECLARACIONES = [
  { name: "preventivos", description: "Mantenimientos preventivos del cronograma: órdenes de equipos (F-MAN-012), inspecciones locativas (F-MAN-009) y actividades de los sistemas de agua purificada. Para '¿qué mantenimientos tengo?', '¿cuáles me faltan?', la carga de un técnico, etc.",
    parameters: { type: "OBJECT", properties: {
      tecnico: S("Nombre del técnico. Vacío o 'yo' = el usuario conectado. 'todos' = sin filtrar por persona."),
      mes: { type: "INTEGER", description: "Mes 1-12. Omitir para todo el año." },
      anio: { type: "INTEGER", description: "Año, por defecto el actual." },
      estado: { type: "STRING", enum: ["todos", "pendientes", "hechos"] },
      tipo: { type: "STRING", enum: ["todos", "equipos", "inspecciones", "agua"] } } } },
  { name: "solicitudes_mantenimiento", description: "Solicitudes de mantenimiento (órdenes de trabajo) que pide producción. Pendientes = abiertas o asignadas sin cerrar.",
    parameters: { type: "OBJECT", properties: {
      tecnico: S("Técnico asignado. 'yo' = el usuario conectado. Vacío o 'todos' = cualquiera."),
      estado: { type: "STRING", enum: ["pendientes", "abierta", "asignada", "cerrada", "rechazada", "todas"] },
      solicitante: S("Quién la pidió; 'yo' = el usuario conectado (opcional)."),
      texto: S("Palabras a buscar: área, equipo, descripción, consecutivo (opcional).") } } },
  { name: "bitacora", description: "Reportes de turno de la Bitácora: qué se hizo (actividades con horas), pendientes y observaciones. Para '¿qué hizo César anoche?', buscar fallas de un equipo, ver pendientes abiertos.",
    parameters: { type: "OBJECT", properties: {
      tecnico: S("Nombre del técnico; 'yo' = el usuario conectado (opcional)."),
      desde: S("Fecha inicial AAAA-MM-DD (opcional)."), hasta: S("Fecha final AAAA-MM-DD (opcional)."),
      turno: S("Turno, ej. 'Turno C' (opcional)."), texto: S("Palabras a buscar, ej. 'caldera' (opcional)."),
      solo_pendientes_abiertos: { type: "BOOLEAN" } } } },
  { name: "almacen", description: "Artículos del almacén: existencias, stock mínimo y ubicación.",
    parameters: { type: "OBJECT", properties: { texto: S("Nombre, código o categoría (opcional)."), solo_bajo_stock: { type: "BOOLEAN" } } } },
  { name: "solicitudes_material", description: "Solicitudes de material o de compra del almacén y su estado.",
    parameters: { type: "OBJECT", properties: { texto: S("Artículo, código o equipo (opcional)."), estado: S("Estado (opcional)."), solicitante: S("'yo' o un nombre (opcional).") } } },
  { name: "historial", description: "Historial de acciones de la app: quién ejecutó, asignó, importó o movió inventario, y cuándo.",
    parameters: { type: "OBJECT", properties: { texto: S("Palabras a buscar (opcional)."), usuario: S("Persona; 'yo' = el usuario conectado (opcional)."), desde: S("Fecha AAAA-MM-DD (opcional).") } } },
  { name: "buscar_en_internet", description: "Solo para dudas técnicas generales (fallas, procedimientos) que no están en los datos de la app.",
    parameters: { type: "OBJECT", properties: { pregunta: S("La pregunta a buscar.") }, required: ["pregunta"] } },
];

function promptSistema(usuario: any) {
  const h = hoyBogota();
  const ayer = new Date(h); ayer.setDate(h.getDate() - 1);
  const dias = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  return `Eres el asistente de la suite Bussié (mantenimiento de la planta de Laboratorios Bussié). Respondes en español, breve y concreto, como a un técnico en planta.

USUARIO CONECTADO: ${usuario?.nombre || usuario?.username || "desconocido"} (usuario: ${usuario?.username || "—"}, cargo: ${usuario?.cargo || "—"}).
Cuando diga "yo", "mis", "tengo", "me faltan", se refiere a esta persona.
HOY: ${dias[h.getDay()]} ${iso(h)}, hora Colombia ${String(h.getHours()).padStart(2, "0")}:${String(h.getMinutes()).padStart(2, "0")}. AYER: ${iso(ayer)}.
Turnos: A 6:00-14:00, B 14:00-22:00, C 22:00-6:00. "Anoche" normalmente es el turno C que empezó ayer (busca ayer y hoy) o el turno B de ayer.

REGLAS:
1. Para cualquier pregunta sobre datos de la app (mantenimientos, inspecciones, agua purificada, solicitudes, bitácora, almacén, historial) USA LAS HERRAMIENTAS. Nunca inventes datos.
2. Responde con conteos y listas cortas (máximo unos 15 renglones). Si hay más, di cuántos son y muestra los más importantes.
3. Di de qué módulo sale la información (ej. "Según la Bitácora…", "En Mantenimiento preventivo…").
4. Si una herramienta no trae resultados, dilo claramente y sugiere cómo preguntar mejor.
5. Solo usa buscar_en_internet para dudas técnicas generales, y cita las fuentes.`;
}

async function llamarGemini(contents: any[], system: string) {
  return await fetchGemini({
    contents, systemInstruction: { parts: [{ text: system }] },
    tools: [{ functionDeclarations: DECLARACIONES }],
    generationConfig: { maxOutputTokens: 1500 },
  });
}

Deno.serve(async (req: Request) => {
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (!GEMINI_API_KEY) return json({ error: "Falta configurar GEMINI_API_KEY en los secretos de la función." }, 500);
  try {
    const { message, history, usuario } = await req.json();
    if (!message || typeof message !== "string") return json({ error: "Falta el mensaje." }, 400);
    const system = promptSistema(usuario);
    const contents: any[] = (Array.isArray(history) ? history.slice(-10) : []).map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user", parts: [{ text: String(h.content ?? "") }] }));
    contents.push({ role: "user", parts: [{ text: message }] });
    const usadas: string[] = [];
    for (let ronda = 0; ronda < 5; ronda++) {
      const r = await llamarGemini(contents, system);
      if (!r.ok) {
        if (r.status === 503 || r.status === 500) return json({ error: "El servicio de Google (Gemini) está saturado en este momento. Espera un minuto y vuelve a preguntar." }, 503);
        if (r.status === 429) return json({ error: "Se alcanzó el límite de preguntas por minuto del plan gratuito de Gemini. Espera un minuto y vuelve a intentar." }, 429);
        return json({ error: "Error de Gemini (" + r.status + "): " + (await r.text()).slice(0, 300) }, 502);
      }
      const d = await r.json();
      const parts: any[] = d?.candidates?.[0]?.content?.parts || [];
      const llamadas = parts.filter((p) => p.functionCall);
      if (!llamadas.length) {
        const answer = parts.map((p) => p.text || "").join("\n").trim() || "No obtuve una respuesta.";
        return json({ answer, herramientas: usadas });
      }
      contents.push({ role: "model", parts });   // se devuelve tal cual (incluye las firmas que pide Gemini)
      const respuestas: any[] = [];
      for (const p of llamadas) {
        const { name, args } = p.functionCall;
        usadas.push(name);
        let resultado: any;
        try { resultado = HERRAMIENTAS[name] ? await HERRAMIENTAS[name](args || {}, usuario) : { error: "Herramienta desconocida" }; }
        catch (e) { resultado = { error: String(e) }; }
        respuestas.push({ functionResponse: { name, response: { content: resultado } } });
      }
      contents.push({ role: "user", parts: respuestas });
    }
    return json({ answer: "La consulta fue muy larga; intenta preguntarlo de forma más específica.", herramientas: usadas });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
