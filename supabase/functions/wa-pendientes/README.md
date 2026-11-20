# wa-pendientes · aviso automático por WhatsApp

Apenas se guarda un reporte de la Bitácora con pendientes, la app le avisa a esta función y ella envía un
WhatsApp a tu número. La función lee el reporte desde la base (no confía en lo que mande el navegador),
nunca envía dos veces el mismo reporte y tiene un tope diario (40 por defecto).

## Instalación (una sola vez)

1. **SQL:** en Supabase → SQL Editor, ejecuta `wa_notificaciones.sql`.
2. **Función:** Supabase → Edge Functions → *Deploy a new function* → nombre `wa-pendientes` → pega el contenido de
   `index.ts` y despliega. (Con la CLI: `supabase functions deploy wa-pendientes`.) Deja activa la verificación de JWT.
3. **Secretos:** Supabase → Project Settings → Edge Functions → Secrets. Según el proveedor:

### Opción A · CallMeBot (gratis, 5 minutos, no oficial)
Los mensajes salen desde el número de CallMeBot hacia **tu** número, que debe activarlo una vez.
1. Sigue las instrucciones de https://www.callmebot.com/blog/free-api-whatsapp-messages/ (le escribes un mensaje al
   bot desde el WhatsApp que va a recibir los avisos y te responde con una *apikey*).
2. Secretos: `WA_PROVIDER=callmebot` · `WA_TO=3001234567` · `CALLMEBOT_KEY=<tu apikey>`

### Opción B · WhatsApp Business Cloud API (oficial, de pago por mensaje)
1. developers.facebook.com → crear app tipo *Business* → producto *WhatsApp*. En *API Setup* copia el **Phone number ID**
   y genera un token (para producción, uno permanente con un *System User*).
2. Con el número de prueba de Meta solo se envía a números que agregues y verifiques en esa pantalla.
3. Crea la plantilla (WhatsApp Manager → Message templates): nombre `pendiente_bitacora`, idioma *Spanish*, categoría *Utility*:

       ⏳ Nuevo pendiente en la Bitácora
       Prioridad: {{1}}
       Técnico: {{2}} · Fecha: {{3}}
       Reporte: {{4}}
       {{5}}

       Bussié Suite · Mantenimiento

   (Meta pide un ejemplo para cada variable; pon valores de muestra.) Espera a que quede *Approved*.
4. Secretos: `WA_PROVIDER=cloud` · `WA_TO=573001234567` · `WA_TOKEN=<token>` · `WA_PHONE_ID=<phone number id>`
   (opcionales: `WA_TEMPLATE`, `WA_LANG` si cambiaste el nombre o el idioma de la plantilla).

### Varios destinos y tope
- `WA_TO` acepta varios números separados por coma: `3001234567,3109876543` (se envía a cada uno).
- `WA_DAILY_MAX` cambia el tope diario de avisos (por defecto 40).

## Probar
En la app: Bitácora → Inicio → **📲 Enviar pendientes por WhatsApp** → arriba dice si el envío automático está activo
y trae el botón **Enviar mensaje de prueba**.

## Si algo no llega
La tabla `wa_notificaciones` guarda el resultado de cada aviso (`estado` y `detalle`):
`select * from wa_notificaciones order by creado_en desc limit 20;`
Un aviso en `error` se reintenta solo cuando la app vuelve a intentarlo (o con el botón de prueba si el problema era la configuración).
