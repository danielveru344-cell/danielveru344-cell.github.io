-- Sistemas de agua purificada (cronogramas F-MAN-003 1200 L/h y 600 L/h, F-MAN-023 120 L/h)
-- Ejecutar una vez en Supabase > SQL Editor.
create table if not exists public.mtto_agua(
  id bigint generated always as identity primary key,
  anio int not null, mes int not null, semana int not null,
  sistema text not null, formato text, actividad text not null, frecuencia text, orden int,
  estado text not null default 'programado',
  asignado_a text, asignado_por text, fecha_asignacion timestamptz, reasignado boolean default false, asignado_original text,
  fecha_ejecucion date, ejecutor text, observaciones text, mes_reprogramado int,
  motivo_rechazo text, rechazado_por text, rechazado_en timestamptz, fecha_emision timestamptz,
  creado_en timestamptz not null default now());
create unique index if not exists mtto_agua_uq on public.mtto_agua(anio,sistema,actividad,mes,semana);
alter table public.mtto_agua enable row level security;
drop policy if exists acceso_mtto_agua on public.mtto_agua;
create policy acceso_mtto_agua on public.mtto_agua for all to anon, authenticated using (true) with check (true);
