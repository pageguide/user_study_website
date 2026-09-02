-- Find V2 — saving one variant's references, without rewriting the claim.
-- =======================================================================
-- Run once in the SQL editor of the V2 project. Idempotent.
--
-- Re-linking a reference changes a few hundred bytes of JSON. Doing it through
-- save_pageguide_find_v2_claim would mean reading the whole claim and writing it
-- back — and a claim carries its captured page, which is eight megabytes. That is
-- slow, and worse, it puts the entire claim at risk to edit one anchor: anything
-- that goes wrong between the read and the write rewrites the page, the question
-- and all four answers from a copy that may already be stale.
--
-- So references get their own writer. It touches ONE path in the jsonb, leaves
-- the answer text alone, and never sees the page HTML at all.

create or replace function public.save_pageguide_find_v2_anchors(
  p_password text,
  p_id text,
  p_variant_key text,
  p_anchors jsonb
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

  -- Normalize first, so every one of the four keys is present as an object and
  -- this merge cannot land on a null parent.
  v_variants := v_variants || jsonb_build_object(
    p_variant_key,
    (v_variants -> p_variant_key) || jsonb_build_object('citation_anchors', v_anchors));

  update public.pageguide_find_v2_claims
  set answer_variants = v_variants,
      -- The legacy top-level column mirrors whichever grounded variant this claim
      -- is pinned to. Kept in step here for the same reason save_pageguide_find_v2_claim
      -- keeps it: a reader that still uses it must not see a stale set of anchors.
      citation_anchors = case when v_correct is false
        then coalesce(v_variants #> array['incorrect_grounding', 'citation_anchors'], '[]'::jsonb)
        else coalesce(v_variants #> array['correct_grounding', 'citation_anchors'], '[]'::jsonb) end,
      updated_at = now()
  where id = p_id;

  return v_variants -> p_variant_key -> 'citation_anchors';
end;
$$;

grant execute on function public.save_pageguide_find_v2_anchors(text, text, text, jsonb) to anon;
