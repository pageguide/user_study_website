-- PageGuide User Study results v2
-- Run this in the Supabase SQL editor before deploying the website code that writes v2 results.

alter table public.study_sessions
  add column if not exists assignment_key text,
  add column if not exists assignment_index bigint,
  add column if not exists assignment_slot bigint;

create table if not exists public.study_assignment_counter (
  assignment_key text primary key,
  next_index bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.study_assignment_counter enable row level security;

create or replace function public.claim_study_assignment(
  p_participant_id text,
  p_assignment_key text default 'default'
)
returns table (
  session_id bigint,
  assignment_index bigint,
  assignment_slot bigint,
  condition_order text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_index bigint;
  cleaned_participant text;
  cleaned_key text;
begin
  cleaned_participant := coalesce(nullif(trim(p_participant_id), ''), 'anon');
  cleaned_key := coalesce(nullif(trim(p_assignment_key), ''), 'default');

  insert into public.study_assignment_counter as c (assignment_key, next_index, updated_at)
  values (cleaned_key, 1, now())
  on conflict (assignment_key) do update
    set next_index = c.next_index + 1,
        updated_at = now()
  returning c.next_index - 1 into claimed_index;

  assignment_index := claimed_index;
  assignment_slot := claimed_index;
  condition_order := 'rr_mixed_g' || assignment_slot::text || '_ng' || (assignment_slot + 1)::text;

  insert into public.study_sessions (
    participant_id,
    condition_order,
    assignment_key,
    assignment_index,
    assignment_slot
  )
  values (
    cleaned_participant,
    condition_order,
    cleaned_key,
    assignment_index,
    assignment_slot
  )
  returning id into session_id;

  return next;
end;
$$;

grant execute on function public.claim_study_assignment(text, text) to anon;

create table if not exists public.study_task_results_v2 (
  id bigint generated always as identity primary key,
  result_key text not null,
  client_run_id text,
  session_id bigint references public.study_sessions (id) on delete cascade,
  participant_id text not null,
  task_id text not null,
  task_type text not null,
  condition text not null,
  task_index smallint not null,
  question_index smallint not null,
  question_or_task text,

  time_ms integer not null,
  answer_time_ms integer,
  answer_multiple_choice_ms integer,
  find_supporting_answer_ms integer,

  answer text,
  answer_correct boolean,
  evidence_responses jsonb,

  guide_answer_correct boolean,
  guide_answer_problems jsonb,
  guide_answer_problem text,
  guide_errors jsonb,

  score_answer_correct boolean,
  score_evidence_precision real,
  score_evidence_recall real,
  score_evidence_exact boolean,
  score_evidence_hop_exact jsonb,

  score_verdict_correct boolean,
  score_problem_precision real,
  score_problem_recall real,
  score_problem_exact boolean,
  score_type_precision real,
  score_type_recall real,
  score_step_precision real,
  score_step_recall real,
  score_step_exact boolean,
  score_no_error_agreement boolean,

  confidence text,
  helpfulness text,
  created_at timestamptz not null default now(),
  unique (result_key)
);

create index if not exists idx_str_v2_session_id on public.study_task_results_v2 (session_id);
create index if not exists idx_str_v2_participant on public.study_task_results_v2 (participant_id);
create index if not exists idx_str_v2_condition_task on public.study_task_results_v2 (condition, task_type);
create index if not exists idx_str_v2_task on public.study_task_results_v2 (task_id, task_type);

alter table public.study_task_results_v2 enable row level security;

drop policy if exists "anon can insert task results v2" on public.study_task_results_v2;
create policy "anon can insert task results v2"
  on public.study_task_results_v2 for insert to anon with check (true);

drop policy if exists "anon can update task results v2" on public.study_task_results_v2;
create policy "anon can update task results v2"
  on public.study_task_results_v2 for update to anon using (true) with check (true);
