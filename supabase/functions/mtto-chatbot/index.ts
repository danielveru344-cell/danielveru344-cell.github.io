// ══════════════════════════════════════════════════════════════
//  mtto-chatbot · Supabase Edge Function
//  Intermediario seguro entre el chatbot flotante y la API de Google Gemini
//  (capa gratis — https://ai.google.dev).
//  1. Busca en los registros internos (bitácora/historial, órdenes de
//     mantenimiento, solicitudes, notas de seguimiento).
//  2. Si encuentra algo relevante, se lo pasa a Gemini como contexto.
//  3. Si no hay nada relevante, deja que Gemini use búsqueda web (grounding).
//  4. Gemini siempre debe citar de dónde salió cada dato.
// ══════════════════════════════════════════════════════════════

const SUPA_URL = "https://mysqkhttdquwicrsjcmg.supabase.co";
// Misma anon key pública que ya usa el resto de la app (protegida por RLS).
const SUPA_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15c3FraHR0ZHF1d2ljcnNqY21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0OTAxMzMsImV4cCI6MjA5MzA2NjEzM30.RBw3DwjQZvoJUhqBIkR6p3LdYhpc3PVMcyZiIe0uGUE";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Actualizado según el error de la API: gemini-2.0-flash fue descontinuado.
// Si esto vuelve a fallar en el futuro, revisa qué modelo recomienda el error
// o consulta https://ai.google.dev/gemini-api/docs/models
const MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STOPWORDS = new Set([
  "el","la","los","las","de","del","un","una","unos","unas","y","o","que","en",
  "por","para","con","no","se","su","sus","al","es","son","como","porque",
  "mi","me","muy","tan","ya","pero","si","fue","fueron","esta","esta,","este",
  "ese","esa","lo","le","les","hay","cuando","donde","desde","hasta"
]);

function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    )
  ).slice(0, 8);
}

async function sbSelect(table: string, columns: string, limit = 200) {
  const r = await fetch(
    `${SUPA_URL}/rest/v1/${table}?select=${columns}&order=id.desc&limit=${limit}`,
    { headers: { apikey: SUPA_ANON_KEY, Authorization: `Bearer ${SUPA_ANON_KEY}` } }
  );
  if (!r.ok) return [];
  try { return await r.json(); } catch { return []; }
}

function matches(row: Record<string, unknown>, fields: string[], keywords: string[]) {
  const blob = fields.map((f) => String(row[f] ?? "")).join(" ")
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return keywords.some((k) => blob.includes(k));
}

async function buscarContextoInterno(pregunta: string) {
  const keywords = extractKeywords(pregunta);
  if (!keywords.length) return { contexto: "", encontrado: false };

  const bloques: string[] = [];

  // 1) Bitácora de turno (tabla bitacora_kv, key='btk_v1' contiene un JSON array)
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/bitacora_kv?key=eq.btk_v1`, {
      headers: { apikey: SUPA_ANON_KEY, Authorization: `Bearer ${SUPA_ANON_KEY}` },
    });
    if (r.ok) {
      const rows = await r.json();
      const entries: any[] = rows.length ? (rows[0].value || []) : [];
      entries.forEach((e: any) => {
        const realizadas = e.realizadas || [];
        const pendientes = e.pendientes || [];
        const relevantesR = realizadas.filter((a: any) => matches({ blob: [a.area, a.desc].join(" ") }, ["blob"], keywords));
        const relevantesP = pendientes.filter((p: any) => matches({ blob: [p.area, p.desc].join(" ") }, ["blob"], keywords));
        const relevanteObs = matches({ blob: e.obs || "" }, ["blob"], keywords);
        if (relevantesR.length || relevantesP.length || relevanteObs) {
          bloques.push(
            `[Bitácora de turno · ${e.tecnico || "—"} · ${e.turno || ""} · ${e.fecha || ""}] ` +
            (relevantesR.length ? `Realizado: ${relevantesR.map((a:any)=>`${a.area}: ${a.desc||""}`).join(" | ")}. ` : "") +
            (relevantesP.length ? `Pendiente: ${relevantesP.map((p:any)=>`${p.area}: ${p.desc||""} [${p.p||""}]`).join(" | ")}. ` : "") +
            (relevanteObs ? `Observaciones: ${e.obs}` : "")
          );
        }
      });
    }
  } catch (_e) { /* tabla no disponible, se ignora */ }

  // 1b) Historial de eventos (auditoría general: ejecuciones, cambios de estado, etc.)
  try {
    const historial = await sbSelect("historial", "id,tipo,descripcion,usuario,created_at", 300);
    const hits = historial.filter((r: any) => matches(r, ["tipo", "descripcion", "usuario"], keywords)).slice(0, 6);
    hits.forEach((r: any) => bloques.push(
      `[Historial #${r.id} · ${r.created_at?.slice(0,10) || ""}] ${r.tipo || ""}: ${r.descripcion || ""} (registrado por ${r.usuario || "—"})`
    ));
  } catch (_e) { /* ignore */ }

  // 2) Órdenes de mantenimiento preventivo (con observaciones/ejecución)
  try {
    const ordenes = await sbSelect(
      "mtto_ordenes",
      "id,equipo_codigo,equipo_desc,estado,observaciones,ejecutor,fecha_ejecucion,anio,mes",
      400
    );
    const hits = ordenes.filter((r: any) => matches(r, ["equipo_codigo","equipo_desc","observaciones"], keywords)).slice(0, 6);
    hits.forEach((r: any) => bloques.push(
      `[Orden Mtto Preventivo #${r.id} · ${r.equipo_codigo || ""} ${r.equipo_desc || ""} · ${r.estado || ""}] Observaciones: ${r.observaciones || "sin observaciones"} (ejecutor: ${r.ejecutor || "—"}, fecha: ${r.fecha_ejecucion || "—"})`
    ));
  } catch (_e) { /* ignore */ }

  // 3) Solicitudes de mantenimiento
  try {
    const solicitudes = await sbSelect(
      "solicitudes_mantenimiento",
      "id,consecutivo,tipo,area_nombre,item_nombre,descripcion,estado",
      300
    );
    const hits = solicitudes.filter((r: any) => matches(r, ["area_nombre","item_nombre","descripcion"], keywords)).slice(0, 6);
    hits.forEach((r: any) => bloques.push(
      `[Solicitud #${r.consecutivo || r.id} · ${r.area_nombre || ""} / ${r.item_nombre || ""}] ${r.descripcion || ""} (estado: ${r.estado || "—"})`
    ));
  } catch (_e) { /* ignore */ }

  // 4) Notas del seguimiento mensual (mtto_meses.notes es un jsonb {taskId: texto})
  try {
    const meses = await sbSelect("mtto_meses", "id,mes,tasks,notes", 24);
    meses.forEach((m: any) => {
      const tasks: any[] = Array.isArray(m.tasks) ? m.tasks : [];
      const notes: Record<string, string> = m.notes || {};
      tasks.forEach((t) => {
        const nota = notes[String(t.id)];
        const blobFields = [t.equipo, t.activ, t.codigo, nota].filter(Boolean).join(" ");
        if (matches({ blob: blobFields }, ["blob"], keywords)) {
          bloques.push(
            `[Seguimiento ${m.mes} · ${t.equipo || ""} (${t.codigo || ""})] Actividad: ${t.activ || ""}. ${nota ? "Nota registrada: " + nota : ""} (responsable: ${t.resp || "—"})`
          );
        }
      });
    });
  } catch (_e) { /* ignore */ }

  return { contexto: bloques.join("\n"), encontrado: bloques.length > 0 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "Falta configurar GEMINI_API_KEY en los secretos de la función." }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { message, history } = await req.json();
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Falta el mensaje." }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { contexto, encontrado } = await buscarContextoInterno(message);

    const systemPrompt = `Eres el asistente de mantenimiento industrial de la planta Bussié (suite de gestión Bussié). Ayudas a técnicos y supervisores con dudas sobre equipos, fallas, y procedimientos.

REGLAS IMPORTANTES:
1. Primero revisa el <contexto_interno> de abajo (viene de la bitácora, órdenes de mantenimiento preventivo, solicitudes y notas de seguimiento de la planta).
2. Si el contexto interno tiene información relevante para responder, básate en ella PRIMERO y cita exactamente el registro (ej: "Según la Orden Mtto Preventivo #123 del [equipo]..." o "Según la Bitácora de turno del [fecha]...").
3. Si el contexto interno NO tiene nada relevante o es insuficiente, usa la búsqueda de Google para investigar posibles causas y soluciones (piensa en manuales técnicos, foros de mantenimiento industrial, fabricantes). Cita SIEMPRE la fuente web con su URL.
4. Nunca mezcles ambas fuentes sin aclarar cuál es cuál. Al final de tu respuesta agrega una línea "📎 Fuente(s): ..." listando de dónde salió la información (interno y/o web).
5. Si de verdad no encuentras nada ni interno ni en la web, dilo con honestidad y sugiere pasos generales de diagnóstico.
6. Sé breve, concreto y práctico — estás hablando con un técnico en planta, no escribas ensayos.

<contexto_interno>
${encontrado ? contexto : "(No se encontraron registros internos relacionados con esta pregunta.)"}
</contexto_interno>`;

    // Gemini usa roles "user"/"model" y el formato contents:[{role, parts:[{text}]}]
    const contents = (Array.isArray(history) ? history.slice(-10) : []).map((h: any) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: String(h.content ?? "") }],
    }));
    contents.push({ role: "user", parts: [{ text: message }] });

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 1200 },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(JSON.stringify({ error: "Error de Gemini: " + errText }), {
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const data = await geminiRes.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const answer = parts.map((p: any) => p.text || "").join("\n\n").trim() || "No obtuve una respuesta.";

    return new Response(JSON.stringify({ answer, usedInternalContext: encontrado }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
