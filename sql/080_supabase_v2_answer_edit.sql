-- Find V2 — let the reference reviewer delete a citation, not just re-link one.
-- ============================================================================
-- Run once in the SQL editor of the V2 project, after sql/070_supabase_v2_anchors.sql. Idempotent.
--
-- Deleting a reference is not the same edit as re-linking one. Re-linking changes only WHERE a
-- phrase lives in the page, so save_pageguide_find_v2_anchors writes `citation_anchors` and nothing
-- else — deliberately, because the answer text is the thing participants are asked to judge and it
-- must not move by side effect.
--
-- A delete has to touch both: the marker comes out of `answer_text`, and its anchor comes out of
-- `citation_anchors`. Doing that as two calls would leave a window where the answer has lost a
-- citation whose anchor is still stored — and if the second call failed, it would stay that way.
-- So `p_answer_text` is added to the SAME function, and the two are written in one statement.
--
-- NULL MEANS "DO NOT TOUCH". A plain re-link keeps passing no answer text and keeps behaving exactly
-- as it did, which is what makes this safe to apply to a project mid-study: the default is the old
-- behaviour, and rewriting the answer is something a caller has to ask for explicitly.

-- DROP THE FOUR-ARGUMENT VERSION FIRST. sql/070_supabase_v2_anchors.sql created
-- save_pageguide_find_v2_anchors(text, text, text, jsonb), and adding a fifth parameter with a
-- default does not replace it — it creates an overload. Postgres then refuses every four-argument
-- call with "function ... is not unique", which is every re-link made from a tab that has not been
-- reloaded. The five-argument version serves those calls itself, because p_answer_text defaults to
-- null and PostgREST resolves by argument NAME, so a body without p_answer_text still matches.
drop function if exists public.save_pageguide_find_v2_anchors(text, text, text, jsonb);

create or replace function public.save_pageguide_find_v2_anchors(
  p_password text,
  p_id text,
  p_variant_key text,
  p_anchors jsonb,
  p_answer_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_anchors jsonb := case when jsonb_typeof(p_anchors) = 'array' then p_anchors else '[]'::jsonb end;
  v_variants jsonb;
  v_correct boolean;
  v_patch jsonb;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if p_variant_key not in ('correct_grounding', 'correct_nongrounding',
                           'incorrect_grounding', 'incorrect_nongrounding') then
    raise exception 'Unknown variant key %', p_variant_key;
  end if;

  select public.pageguide_v2_normalize_variants(answer_variants), claim_correct
    into v_variants, v_correct
    from public.pageguide_find_v2_claims
   where id = p_id;

  if v_variants is null then
    raise exception 'No Find V2 claim with id %', p_id;
  end if;

  -- An answer emptied entirely is almost always a mistake rather than an intention: a live claim
  -- needs text in every cell it can be dealt, and a blank one reaches a participant as an empty
  -- answer card. Refused here rather than in the browser, as every other rule in this schema is.
  if p_answer_text is not null and btrim(p_answer_text) = '' then
    raise exception 'Refusing to save an empty answer for %. Delete the claim, or write a replacement.', p_variant_key;
  end if;

  v_patch := jsonb_build_object('citation_anchors', v_anchors);
  if p_answer_text is not null then
    v_patch := v_patch || jsonb_build_object('answer_text', p_answer_text);
  end if;

  -- Normalize first, so every one of the four keys is present as an object and this merge cannot
  -- land on a null parent.
  v_variants := v_variants || jsonb_build_object(
    p_variant_key, (v_variants -> p_variant_key) || v_patch);

  update public.pageguide_find_v2_claims
  set answer_variants = v_variants,
      -- The legacy top-level columns mirror whichever grounded variant this claim is pinned to.
      -- Kept in step here for the same reason save_pageguide_find_v2_claim keeps them: a reader that
      -- still uses them must not see a stale answer or a stale set of anchors.
      citation_anchors = case when v_correct is false
        then coalesce(v_variants #> array['incorrect_grounding', 'citation_anchors'], '[]'::jsonb)
        else coalesce(v_variants #> array['correct_grounding', 'citation_anchors'], '[]'::jsonb) end,
      answer_text = case
        when p_answer_text is null then answer_text
        when v_correct is false and p_variant_key = 'incorrect_grounding' then p_answer_text
        when v_correct is not false and p_variant_key = 'correct_grounding' then p_answer_text
        else answer_text end,
      updated_at = now()
  where id = p_id;

  return v_variants -> p_variant_key;
end;
$$;

grant execute on function public.save_pageguide_find_v2_anchors(text, text, text, jsonb, text) to anon;
