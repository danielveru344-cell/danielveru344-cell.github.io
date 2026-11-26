-- Registro de avisos de WhatsApp de la Bitácora (lo usa la función wa-pendientes).
-- Ejecutar una vez en Supabase > SQL Editor.
create table if not exists public.wa_notificaciones(
  id bigint generated always as identity primary key,
  entry_id text not null unique,          -- id del reporte de la Bitácora (un aviso por reporte)
  consecutivo text,
  estado text not null default 'enviando', -- enviando | enviado | error
  detalle text,
  creado_en timestamptz not null default now(),
  enviado_en timestamptz
);
create index if not exists wa_notificaciones_creado on public.wa_notificaciones(creado_en desc);
-- Solo la función (con la llave de servicio) escribe aquí; la app no necesita acceso directo.
alter table public.wa_notificaciones enable row level security;
