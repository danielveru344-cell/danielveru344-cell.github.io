// ══════════════════════════════════════════════════════════════
//  wa-pendientes · Supabase Edge Function
//  Apenas se registra un reporte de la Bitácora con pendientes, envía un
//  aviso por WhatsApp a un número (o varios) que tú defines.
//
//  Cómo funciona
//   1. La app, al guardar el reporte, llama a esta función con el id del reporte.
//   2. La función busca ese reporte en la base (no confía en lo que mande el
//      navegador), toma sus pendientes abiertos y arma el mensaje.
//   3. Lo envía con el proveedor elegido en los secretos (WA_PROVIDER):
//        · "cloud"     → API oficial de WhatsApp Business (Meta). Plantilla aprobada.
//        · "callmebot" → servicio gratuito no oficial (solo para números que lo activen).
//   4. Deja un registro en wa_notificaciones: un reporte nunca se envía dos veces,
//      y hay un tope diario para que nadie pueda llenar el WhatsApp de mensajes.
//
//  Secretos (Supabase → Project Settings → Edge Functions → Secrets):
//   WA_PROVIDER   cloud | callmebot
//   WA_TO         número(s) destino, solo dígitos, separados por coma. Ej: 573001234567
//   cloud:        WA_TOKEN, WA_PHONE_ID, WA_TEMPLATE (por defecto pendiente_bitacora), WA_LANG (por defecto es)
//   callmebot:    CALLMEBOT_KEY
//   opcionales:   WA_DAILY_MAX (por defecto 40)
//  SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya existen automáticamente en las Edge Functions.
// ══════════════════════════════════════════════════════════════

const env = (k: string): string => {
  try { return (Deno.env.get(k) ?? "").trim(); }
  catch (_e) { return String((globalThis as any).__ENV?.[k] ?? "").trim(); }
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── utilidades ───────────────────────────────────────────────────────────────
// Celular colombiano de 10 dígitos que empieza por 3 → se le antepone el 57.
function normNumero(v: string): string {
  const s = String(v || "").replace(/\D/g, "");
  return s.length === 10 && s.charAt(0) === "3" ? "57" + s : s;
}
function destinos(): string[] {
  return env("WA_TO").split(",").map(normNumero).filter((n) => n.length >= 11);
}
function enmascarar(n: string): string { return "••••" + n.slice(-4); }
function fechaBogota(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function fechaLarga(iso: string): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
// Para el texto libre: sin * _ ~ ` (rompen el formato de WhatsApp) y sin espacios de más.
function limpio(t: unknown, max = 0): string {
  const s = String(t ?? "").replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim();
  return max && s.length > max ? s.slice(0, max - 1).trim() + "…" : s;
}
// Los parámetros de una plantilla no admiten saltos de línea, tabulaciones ni más de 4 espacios seguidos.
function paramPlantilla(t: unknown, max = 0): string {
  const s = String(t ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return (max && s.length > max ? s.slice(0, max - 1).trim() + "…" : s) || "—";
}
const PRIOS = ["Alta", "Media", "Baja"];
const ICO: Record<string, string> = { Alta: "🔴", Media: "🟠", Baja: "🟢" };
function prioDe(p: any): string { return PRIOS.indexOf(p?.p) >= 0 ? p.p : "Media"; }

// Mensaje de texto libre (CallMeBot): una línea por pendiente.
function armarTexto(entry: any, pends: any[]): string {
  const ord = pends.slice().sort((a, b) => PRIOS.indexOf(prioDe(a)) - PRIOS.indexOf(prioDe(b)));
  const cab = pends.length === 1 ? "⏳ *NUEVO PENDIENTE*" : `⏳ *${pends.length} NUEVOS PENDIENTES*`;
  const lineas = ord.map((p) => `${ICO[prioDe(p)]} *${prioDe(p)}* · *${limpio(p.area, 60)}*\n${limpio(p.desc, 220)}`);
  const pie = [
    entry.tecnico ? "👷 " + limpio(entry.tecnico, 40) : "",
    entry.fecha ? "📅 " + fechaLarga(entry.fecha) : "",
    entry.consecutivo ? "🧾 " + limpio(entry.consecutivo, 24) : "",
  ].filter(Boolean).join(" · ");
  return [cab, ...lineas, pie].filter(Boolean).join("\n\n");
}
// Parámetros de la plantilla de WhatsApp Business (en una sola línea cada uno).
//   {{1}} prioridad  {{2}} técnico  {{3}} fecha  {{4}} reporte  {{5}} detalle
function armarParams(entry: any, pends: any[]): string[] {
  const mayor = PRIOS.find((pr) => pends.some((p) => prioDe(p) === pr)) || "Media";
  const prio = pends.length === 1 ? `${ICO[mayor]} ${mayor}` : `${ICO[mayor]} ${mayor} (${pends.length} pendientes)`;
  const detalle = pends
    .slice().sort((a, b) => PRIOS.indexOf(prioDe(a)) - PRIOS.indexOf(prioDe(b)))
    .map((p, i) => `${pends.length > 1 ? (i + 1) + ") " : ""}${limpio(p.area, 50)}: ${limpio(p.desc, 200)}`).join(" | ");
  return [
    paramPlantilla(prio, 60),
    paramPlantilla(entry.tecnico, 60),
    paramPlantilla(fechaLarga(entry.fecha), 20),
    paramPlantilla(entry.consecutivo, 30),
    paramPlantilla(detalle, 700),
  ];
}

// ── proveedores ──────────────────────────────────────────────────────────────
async function enviarCloud(to: string, params: string[]): Promise<{ ok: boolean; detalle: string }> {
  const r = await fetch(`https://graph.facebook.com/v21.0/${env("WA_PHONE_ID")}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("WA_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: env("WA_TEMPLATE") || "pendiente_bitacora",
        language: { code: env("WA_LANG") || "es" },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    }),
  });
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, detalle: `WhatsApp ${r.status}: ${cuerpo?.error?.message || "error"}` };
  return { ok: true, detalle: cuerpo?.messages?.[0]?.id || "enviado" };
}
async function enviarCallMeBot(to: string, texto: string): Promise<{ ok: boolean; detalle: string }> {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${to}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(env("CALLMEBOT_KEY"))}`;
  const r = await fetch(url);
  const t = await r.text().catch(() => "");
  if (!r.ok || /error/i.test(t)) return { ok: false, detalle: `CallMeBot ${r.status}: ${t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}` };
  return { ok: true, detalle: "enviado" };
}
function configurado(): { ok: boolean; proveedor: string; falta: string[] } {
  const prov = env("WA_PROVIDER").toLowerCase();
  const falta: string[] = [];
  if (prov !== "cloud" && prov !== "callmebot") falta.push("WA_PROVIDER (cloud o callmebot)");
  if (!destinos().length) falta.push("WA_TO");
  if (prov === "cloud") { if (!env("WA_TOKEN")) falta.push("WA_TOKEN"); if (!env("WA_PHONE_ID")) falta.push("WA_PHONE_ID"); }
  if (prov === "callmebot" && !env("CALLMEBOT_KEY")) falta.push("CALLMEBOT_KEY");
  return { ok: falta.length === 0, proveedor: prov, falta };
}
// Envía el mensaje a todos los destinos; cuenta como enviado si llegó al menos a uno.
async function enviar(entry: any, pends: any[]): Promise<{ ok: boolean; detalle: string; destinos: number }> {
  const prov = env("WA_PROVIDER").toLowerCase();
  const texto = prov === "callmebot" ? armarTexto(entry, pends) : "";
  const params = prov === "cloud" ? armarParams(entry, pends) : [];
  const res: string[] = []; let buenos = 0; const dest = destinos();
  for (const to of dest) {
    let r: { ok: boolean; detalle: string };
    try { r = prov === "cloud" ? await enviarCloud(to, params) : await enviarCallMeBot(to, texto); }
    catch (e) { r = { ok: false, detalle: "sin conexión: " + String((e as any)?.message || e) }; }
    if (r.ok) buenos++;
    res.push(`${enmascarar(to)} ${r.ok ? "✓" : "✗"} ${r.detalle}`);
  }
  return { ok: buenos > 0, detalle: res.join(" · ").slice(0, 300), destinos: dest.length };
}

// ── base de datos (REST con la llave de servicio) ────────────────────────────
function sbHeaders(extra: Record<string, string> = {}) {
  const k = env("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", ...extra };
}
const sbUrl = (p: string) => `${env("SUPABASE_URL")}/rest/v1/${p}`;

// Busca el reporte en la bitácora; la app lo guarda justo antes de llamar, así que se reintenta unos segundos.
async function buscarReporte(id: string): Promise<any | null> {
  const intentos = parseInt(env("WA_REINTENTOS") || "5", 10), espera = parseInt(env("WA_REINTENTO_MS") || "1200", 10);
  for (let i = 0; i < intentos; i++) {
    const r = await fetch(sbUrl("bitacora_kv?key=eq.btk_v1&select=value"), { headers: sbHeaders() });
    if (r.ok) {
      const filas = await r.json().catch(() => []);
      const lista = Array.isArray(filas?.[0]?.value) ? filas[0].value : [];
      const e = lista.find((x: any) => x && x.id === id);
      if (e) return e;
    }
    if (i < intentos - 1) await dormir(espera);
  }
  return null;
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, motivo: "metodo" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch (_e) { return json({ ok: false, motivo: "cuerpo_invalido" }, 400); }
  const cfg = configurado();

  // Estado: la app lo consulta para mostrar si el envío automático está listo.
  if (body.accion === "estado") {
    return json({ ok: true, configurado: cfg.ok, proveedor: cfg.proveedor || null, falta: cfg.falta, destinos: destinos().map(enmascarar) });
  }
  if (!cfg.ok) return json({ ok: false, motivo: "no_configurado", falta: cfg.falta });

  // Prueba: un mensaje de ejemplo a los destinos, para comprobar que todo quedó bien.
  if (body.accion === "prueba") {
    const ejemplo = { tecnico: "Prueba · Bussié Suite", fecha: fechaBogota(), consecutivo: "PRUEBA" };
    const p = [{ area: "PRUEBA DE ENVÍO", desc: "Si recibes este mensaje, el envío automático de pendientes quedó funcionando.", p: "Media" }];
    const r = await enviar(ejemplo, p);
    return json({ ok: r.ok, enviado: r.ok, detalle: r.detalle, destinos: destinos().map(enmascarar) }, r.ok ? 200 : 502);
  }

  const entryId = String(body.entryId || "");
  if (!entryId) return json({ ok: false, motivo: "falta_entryId" }, 400);

  const entry = await buscarReporte(entryId);
  if (!entry) return json({ ok: false, motivo: "reporte_no_encontrado" }, 404);
  if (entry.esAcompanante) return json({ ok: true, enviado: false, motivo: "acompanante" });
  const pends = (entry.pendientes || []).filter((p: any) => p && !p.cerrado);
  if (!pends.length) return json({ ok: true, enviado: false, motivo: "sin_pendientes" });

  // Tope diario
  const max = parseInt(env("WA_DAILY_MAX") || "40", 10);
  const inicio = `${fechaBogota()}T00:00:00-05:00`;
  const hoy = await fetch(sbUrl(`wa_notificaciones?estado=eq.enviado&creado_en=gte.${encodeURIComponent(inicio)}&select=id`), { headers: sbHeaders() });
  if (hoy.ok) { const n = (await hoy.json().catch(() => [])).length; if (n >= max) return json({ ok: false, motivo: "limite_diario", limite: max }, 429); }

  // Un reporte, un solo aviso (si el intento anterior falló, se reintenta).
  const ins = await fetch(sbUrl("wa_notificaciones?on_conflict=entry_id"), {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify({ entry_id: entryId, consecutivo: entry.consecutivo || null, estado: "enviando" }),
  });
  if (!ins.ok) return json({ ok: false, motivo: "registro_no_disponible", detalle: `tabla wa_notificaciones: HTTP ${ins.status}` }, 500);
  const creada = await ins.json().catch(() => []);
  if (!creada.length) {
    const ex = await (await fetch(sbUrl(`wa_notificaciones?entry_id=eq.${encodeURIComponent(entryId)}&select=estado`), { headers: sbHeaders() })).json().catch(() => []);
    if (ex?.[0]?.estado !== "error") return json({ ok: true, enviado: false, motivo: "ya_enviado" });
    await fetch(sbUrl(`wa_notificaciones?entry_id=eq.${encodeURIComponent(entryId)}`), { method: "PATCH", headers: sbHeaders(), body: JSON.stringify({ estado: "enviando" }) });
  }

  const r = await enviar(entry, pends);
  await fetch(sbUrl(`wa_notificaciones?entry_id=eq.${encodeURIComponent(entryId)}`), {
    method: "PATCH", headers: sbHeaders(),
    body: JSON.stringify({ estado: r.ok ? "enviado" : "error", detalle: r.detalle, enviado_en: r.ok ? new Date().toISOString() : null }),
  });
  return json({ ok: r.ok, enviado: r.ok, pendientes: pends.length, destinos: r.destinos, detalle: r.ok ? undefined : r.detalle }, r.ok ? 200 : 502);
}

if ((globalThis as any).__PRUEBA__) { (globalThis as any).__handler = handler; }   // solo para las pruebas automáticas
else if (typeof Deno !== "undefined" && (Deno as any).serve) { Deno.serve(handler); }
