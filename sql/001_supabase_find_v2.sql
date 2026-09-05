-- PageGuide Find V2 — isolated Supabase schema
-- ============================================================
-- Run this entire file in the SQL editor of the NEW Supabase project.
-- It does not create, alter, or read any of the V1 study tables.
--
-- Find V2 stores one editable Find item per row. Each row carries FOUR authored
-- agent answers in `answer_variants` -- correct/incorrect x grounded/non-grounded
-- -- each with its own answer text and its own references. Which of the four a
-- participant sees is counterbalanced from their assignment slot, so the
-- participant's Yes/No judgment is scored against the variant they were shown
-- rather than against a fixed property of the row.

create extension if not exists pgcrypto with schema extensions;

-- One row per versioned Find claim. Keeping the page snapshot with the claim
-- makes a blank project self-contained. Queue queries explicitly omit
-- `page_html`, so the multi-megabyte page is fetched only when its task opens.
create table if not exists public.pageguide_find_v2_claims (
  id                    text primary key,
  source_task_id        text,
  title                 text,
  url                   text not null default '',
  task_style            text not null default 'find_text'
                          check (task_style in ('find_text', 'find_visual')),
  question              text not null default '',
  -- The four authored answers. Shape:
  --   { "correct_grounding":      {"answer_text": "...", "citation_anchors": [], "evidence": []},
  --     "correct_nongrounding":   {...}, "incorrect_grounding": {...},
  --     "incorrect_nongrounding": {...} }
  answer_variants       jsonb not null default '{}'::jsonb,
  -- How this row's correctness axis is assigned. 'balanced' lets the slot
  -- counterbalance it; the pinned modes are for items that only have one
  -- defensible key (e.g. no plausible wrong answer could be authored).
  correctness_mode      text not null default 'balanced'
                          check (correctness_mode in ('balanced', 'always_correct', 'always_incorrect')),
  -- Legacy single-answer columns, kept so rows authored before the four-variant
  -- editor still play. They are the last fallback when a variant is blank.
  answer_text           text not null default '',
  claim_correct         boolean not null default true,
  evidence              jsonb not null default '[]'::jsonb,
  citation_anchors      jsonb not null default '[]'::jsonb,
  evidence_ground_truth jsonb not null default '{}'::jsonb,
  page_title            text,
  page_html             text not null default '',
  page_bytes            integer,
  in_study              boolean not null default false,
  task_index            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One row per sitting. `assignment_slot` counterbalances BOTH axes at once.
-- The browser deals variant (slot + task_index) % 4 down the queue, cycling
-- correct/grounded -> correct/non-grounded -> incorrect/grounded ->
-- incorrect/non-grounded, so four consecutive slots cover every cell of every
-- claim and no single participant sees one claim twice.
create table if not exists public.pageguide_find_v2_sessions (
  id                bigint generated always as identity primary key,
  participant_id    text not null,
  assignment_slot   bigint not null,
  condition_order   text not null,
  created_at        timestamptz not null default now()
);

-- One row per submitted claim judgment.
create table if not exists public.pageguide_find_v2_results (
  id                         bigint generated always as identity primary key,
  result_key                 text not null unique,
  client_run_id              text,
  session_id                 bigint references public.pageguide_find_v2_sessions (id) on delete cascade,
  participant_id             text not null,
  claim_id                   text not null references public.pageguide_find_v2_claims (id),
  task_index                 integer not null,
  question_index             integer not null,
  task_style                 text not null,
  condition                  text not null check (condition in ('grounding', 'nongrounding')),
  -- Which of the four authored answers this participant actually saw, and the
  -- key it was scored against. `condition` is the grounding half of the same
  -- variant, kept as its own column so existing arm queries still read plainly.
  variant_key                text not null default 'correct_grounding'
                               check (variant_key in ('correct_grounding', 'correct_nongrounding',
                                                      'incorrect_grounding', 'incorrect_nongrounding')),
  question                   text not null,
  claim_text_snapshot        text not null,
  claim_correct_snapshot     boolean not null,
  participant_verdict        boolean not null,
  verdict_correct            boolean not null,
  answer_time_ms             integer not null,
  verdict_time_ms            integer,
  evidence_time_ms           integer,
  evidence_responses         jsonb not null default '[]'::jsonb,
  score_evidence_precision   real,
  score_evidence_recall      real,
  score_evidence_exact       boolean,
  score_evidence_hop_exact   jsonb,
  confidence                 text,
  helpfulness                text,
  notes                      text,
  interaction_summary        jsonb,
  scroll_user_count          integer,
  ctrl_f_count               integer,
  text_select_count          integer,
  click_count                integer,
  mouse_move_px              integer,
  created_at                 timestamptz not null default now()
);

-- Upgrade path for a project that already ran the first version of this file,
-- where a claim held one answer instead of four. `create table if not exists`
-- above is a no-op on such a project, so the new columns are added here and the
-- single authored answer is lifted into the variant that matches its old key.
alter table public.pageguide_find_v2_claims
  add column if not exists answer_variants jsonb not null default '{}'::jsonb;
alter table public.pageguide_find_v2_claims
  add column if not exists correctness_mode text not null default 'balanced';
alter table public.pageguide_find_v2_claims
  alter column claim_correct set default true;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pageguide_find_v2_claims'::regclass
      and conname = 'pageguide_find_v2_claims_correctness_mode_check'
  ) then
    alter table public.pageguide_find_v2_claims
      add constraint pageguide_find_v2_claims_correctness_mode_check
      check (correctness_mode in ('balanced', 'always_correct', 'always_incorrect'));
  end if;
end;
$$;

-- Seed the matching variant from the legacy columns, once, for rows that have
-- no authored variants yet. Pinning correctness_mode keeps those rows behaving
-- exactly as they did before this migration until they are re-authored.
update public.pageguide_find_v2_claims
set answer_variants = jsonb_build_object(
      case when claim_correct then 'correct_grounding' else 'incorrect_grounding' end,
      jsonb_build_object(
        'answer_text', answer_text,
        'citation_anchors', citation_anchors,
        'evidence', evidence)),
    correctness_mode = case when claim_correct then 'always_correct' else 'always_incorrect' end
where answer_variants = '{}'::jsonb
  and coalesce(answer_text, '') <> '';

alter table public.pageguide_find_v2_results
  add column if not exists variant_key text not null default 'correct_grounding';
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pageguide_find_v2_results'::regclass
      and conname = 'pageguide_find_v2_results_variant_key_check'
  ) then
    alter table public.pageguide_find_v2_results
      add constraint pageguide_find_v2_results_variant_key_check
      check (variant_key in ('correct_grounding', 'correct_nongrounding',
                             'incorrect_grounding', 'incorrect_nongrounding'));
  end if;
end;
$$;

-- Indexes come after the upgrade block on purpose: on a project that already
-- ran an earlier version of this file, the `create table if not exists` above
-- is a no-op, so the columns these index are added by the ALTERs, not by it.
create index if not exists idx_pg_find_v2_claim_queue
  on public.pageguide_find_v2_claims (in_study, task_index, id);
create index if not exists idx_pg_find_v2_claim_correct
  on public.pageguide_find_v2_claims (correctness_mode, task_style);

create index if not exists idx_pg_find_v2_result_session
  on public.pageguide_find_v2_results (session_id);
create index if not exists idx_pg_find_v2_result_claim
  on public.pageguide_find_v2_results (claim_id, condition);
create index if not exists idx_pg_find_v2_result_variant
  on public.pageguide_find_v2_results (variant_key, task_style);
create index if not exists idx_pg_find_v2_result_created
  on public.pageguide_find_v2_results (created_at desc);

-- Private settings: no anon policy and no direct grants. The password hash is
-- checked only inside SECURITY DEFINER functions. The browser never contains a
-- service-role key and the admin password is kept only for this browser tab.
create table if not exists public.pageguide_find_v2_settings (
  singleton           boolean primary key default true check (singleton),
  admin_password_hash text,
  next_assignment     bigint not null default 0,
  updated_at          timestamptz not null default now()
);

insert into public.pageguide_find_v2_settings (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.pageguide_find_v2_claims enable row level security;
alter table public.pageguide_find_v2_sessions enable row level security;
alter table public.pageguide_find_v2_results enable row level security;
alter table public.pageguide_find_v2_settings enable row level security;

grant select on public.pageguide_find_v2_claims to anon;
grant insert, update on public.pageguide_find_v2_results to anon;
grant usage, select on sequence public.pageguide_find_v2_results_id_seq to anon;

drop policy if exists "anon reads Find V2 claims" on public.pageguide_find_v2_claims;
create policy "anon reads Find V2 claims"
  on public.pageguide_find_v2_claims for select to anon using (true);

drop policy if exists "anon inserts Find V2 results" on public.pageguide_find_v2_results;
create policy "anon inserts Find V2 results"
  on public.pageguide_find_v2_results for insert to anon with check (true);

drop policy if exists "anon updates Find V2 result retries" on public.pageguide_find_v2_results;
create policy "anon updates Find V2 result retries"
  on public.pageguide_find_v2_results for update to anon using (true) with check (true);

-- Run this function yourself in the SQL editor after the schema is installed:
--
--   select public.set_pageguide_find_v2_admin_password('your long private password');
--
-- It is deliberately not executable by the browser roles.
create or replace function public.set_pageguide_find_v2_admin_password(p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'The Find V2 admin password must be at least 12 characters.';
  end if;

  update public.pageguide_find_v2_settings
  set admin_password_hash = encode(digest(p_password, 'sha256'), 'hex'),
      updated_at = now()
  where singleton = true;
end;
$$;

revoke all on function public.set_pageguide_find_v2_admin_password(text) from public, anon, authenticated;

create or replace function public.pageguide_find_v2_require_admin(p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  expected_hash text;
begin
  select admin_password_hash into expected_hash
  from public.pageguide_find_v2_settings
  where singleton = true;

  if expected_hash is null then
    raise exception 'Find V2 admin password is not configured. Run set_pageguide_find_v2_admin_password in the SQL editor.'
      using errcode = '28000';
  end if;

  if encode(digest(coalesce(p_password, ''), 'sha256'), 'hex') <> expected_hash then
    raise exception 'Incorrect Find V2 admin password.' using errcode = '28000';
  end if;
end;
$$;

revoke all on function public.pageguide_find_v2_require_admin(text) from public, anon, authenticated;

-- A lightweight login check for the Admin panel.
create or replace function public.pageguide_find_v2_admin_check(p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return true;
end;
$$;

grant execute on function public.pageguide_find_v2_admin_check(text) to anon;

-- Create or update a claim. All validation is repeated here because browser
-- validation is guidance, not an authorization boundary.
--
-- `answer_variants` is normalized here rather than trusted: the browser may send
-- extra keys, missing keys, or a string where an object belongs, and a queue
-- query that hits any of those at run time fails in front of a participant.
create or replace function public.save_pageguide_find_v2_claim(
  p_password text,
  p_claim jsonb
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text := nullif(btrim(p_claim ->> 'id'), '');
  v_style text := coalesce(nullif(btrim(p_claim ->> 'task_style'), ''), 'find_text');
  v_question text := coalesce(btrim(p_claim ->> 'question'), '');
  v_url text := coalesce(btrim(p_claim ->> 'url'), '');
  v_in_study boolean := coalesce((p_claim ->> 'in_study')::boolean, false);
  v_page_html text := coalesce(p_claim ->> 'page_html', '');
  v_mode text := coalesce(nullif(btrim(p_claim ->> 'correctness_mode'), ''), 'balanced');
  v_in jsonb := case when jsonb_typeof(p_claim -> 'answer_variants') = 'object'
                     then p_claim -> 'answer_variants' else '{}'::jsonb end;
  v_variants jsonb := '{}'::jsonb;
  v_key text;
  v_one jsonb;
  v_text text;
  v_needed text[];
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$' then
    raise exception 'Claim id must be 2-80 characters using letters, numbers, dot, dash, or underscore.';
  end if;
  if v_style not in ('find_text', 'find_visual') then
    raise exception 'task_style must be find_text or find_visual.';
  end if;
  if v_mode not in ('balanced', 'always_correct', 'always_incorrect') then
    raise exception 'correctness_mode must be balanced, always_correct, or always_incorrect.';
  end if;

  -- Keep only the four known keys, each in the one shape the player reads.
  foreach v_key in array array['correct_grounding', 'correct_nongrounding',
                               'incorrect_grounding', 'incorrect_nongrounding']
  loop
    v_one := case when jsonb_typeof(v_in -> v_key) = 'object' then v_in -> v_key else '{}'::jsonb end;
    v_text := coalesce(btrim(v_one ->> 'answer_text'), '');
    v_variants := v_variants || jsonb_build_object(v_key, jsonb_build_object(
      'answer_text', v_text,
      'citation_anchors', case when jsonb_typeof(v_one -> 'citation_anchors') = 'array'
                               then v_one -> 'citation_anchors' else '[]'::jsonb end,
      'evidence', case when jsonb_typeof(v_one -> 'evidence') = 'array'
                       then v_one -> 'evidence' else '[]'::jsonb end));
  end loop;

  -- A live claim must have text for every variant a participant can be dealt.
  -- Refusing this here is the difference between an authoring mistake and a
  -- participant reaching a task with a blank agent answer.
  if v_in_study then
    v_needed := case v_mode
      when 'always_correct' then array['correct_grounding', 'correct_nongrounding']
      when 'always_incorrect' then array['incorrect_grounding', 'incorrect_nongrounding']
      else array['correct_grounding', 'correct_nongrounding',
                 'incorrect_grounding', 'incorrect_nongrounding']
    end;
    foreach v_key in array v_needed loop
      if coalesce(v_variants #>> array[v_key, 'answer_text'], '') = '' then
        raise exception 'A live claim needs an authored answer for %. Fill it in or pin correctness_mode.', v_key;
      end if;
    end loop;
    if v_question = '' or v_url = '' or v_page_html = '' then
      raise exception 'A live claim needs a question, URL, and captured page HTML.';
    end if;
  end if;

  insert into public.pageguide_find_v2_claims (
    id, source_task_id, title, url, task_style, question, answer_variants, correctness_mode,
    answer_text, claim_correct, evidence, citation_anchors, evidence_ground_truth,
    page_title, page_html, page_bytes, in_study, task_index, updated_at
  ) values (
    v_id,
    nullif(btrim(p_claim ->> 'source_task_id'), ''),
    nullif(btrim(p_claim ->> 'title'), ''),
    v_url,
    v_style,
    v_question,
    v_variants,
    v_mode,
    -- The legacy columns now mirror the grounded variant of the key this row
    -- leans to, so anything still reading them sees a coherent single answer.
    case when v_mode = 'always_incorrect'
         then coalesce(v_variants #>> array['incorrect_grounding', 'answer_text'], '')
         else coalesce(v_variants #>> array['correct_grounding', 'answer_text'], '') end,
    v_mode <> 'always_incorrect',
    case when v_mode = 'always_incorrect'
         then coalesce(v_variants #> array['incorrect_grounding', 'evidence'], '[]'::jsonb)
         else coalesce(v_variants #> array['correct_grounding', 'evidence'], '[]'::jsonb) end,
    case when v_mode = 'always_incorrect'
         then coalesce(v_variants #> array['incorrect_grounding', 'citation_anchors'], '[]'::jsonb)
         else coalesce(v_variants #> array['correct_grounding', 'citation_anchors'], '[]'::jsonb) end,
    case when jsonb_typeof(p_claim -> 'evidence_ground_truth') = 'object' then p_claim -> 'evidence_ground_truth' else '{}'::jsonb end,
    nullif(btrim(p_claim ->> 'page_title'), ''),
    v_page_html,
    length(convert_to(v_page_html, 'UTF8')),
    v_in_study,
    coalesce((p_claim ->> 'task_index')::integer, 0),
    now()
  )
  on conflict (id) do update set
    source_task_id = excluded.source_task_id,
    title = excluded.title,
    url = excluded.url,
    task_style = excluded.task_style,
    question = excluded.question,
    answer_variants = excluded.answer_variants,
    correctness_mode = excluded.correctness_mode,
    answer_text = excluded.answer_text,
    claim_correct = excluded.claim_correct,
    evidence = excluded.evidence,
    citation_anchors = excluded.citation_anchors,
    evidence_ground_truth = excluded.evidence_ground_truth,
    page_title = excluded.page_title,
    page_html = excluded.page_html,
    page_bytes = excluded.page_bytes,
    in_study = excluded.in_study,
    task_index = excluded.task_index,
    updated_at = now();

  return v_id;
end;
$$;

grant execute on function public.save_pageguide_find_v2_claim(text, jsonb) to anon;

-- Atomically claim the next counterbalancing slot and create the session.
create or replace function public.claim_pageguide_find_v2_session(p_participant_id text)
returns table (session_id bigint, assignment_slot bigint, condition_order text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant text := coalesce(nullif(btrim(p_participant_id), ''), 'anonymous');
begin
  update public.pageguide_find_v2_settings
  set next_assignment = next_assignment + 1,
      updated_at = now()
  where singleton = true
  returning next_assignment - 1 into assignment_slot;

  condition_order := 'find_v2_cycle4_from_' || case assignment_slot % 4
    when 0 then 'correct_grounding'
    when 1 then 'correct_nongrounding'
    when 2 then 'incorrect_grounding'
    else 'incorrect_nongrounding'
  end;

  insert into public.pageguide_find_v2_sessions (
    participant_id, assignment_slot, condition_order
  ) values (
    v_participant, assignment_slot, condition_order
  ) returning id into session_id;

  return next;
end;
$$;

grant execute on function public.claim_pageguide_find_v2_session(text) to anon;

-- Results are private under RLS; Admin reads them through this password-checked
-- function. The cap protects the browser from an accidental unbounded response.
create or replace function public.pageguide_find_v2_admin_results(
  p_password text,
  p_limit integer default 20000
)
returns setof public.pageguide_find_v2_results
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return query
    select * from public.pageguide_find_v2_results
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 20000), 20000));
end;
$$;

grant execute on function public.pageguide_find_v2_admin_results(text, integer) to anon;
