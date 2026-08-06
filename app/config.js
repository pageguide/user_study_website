// Supabase configuration — the SAME project the PageGuide extension writes to.
//
// Copied from the extension's sidepanel/supabase_config.js so a participant running in the browser
// and one running in the extension land in the same tables. Gitignored: never commit this file.
//
// This is the ANON key, and the only key that belongs in a file served to participants. It can read
// the stimulus tables and insert results, and nothing else — see the RLS policies in
// pageguide/supabase_schema.sql. Publishing stimuli needs the service_role key, which is typed into
// the extension's recorder when it is used and never stored anywhere.

window.STUDY_CONFIG = {
  SUPABASE_URL: 'https://yobxudoqpzoywippylgb.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_hdexCbaJrP0dxXKWLlRFHQ_4UnLoYFm',

  HALF: 'guide',

  // 'url'    — ?arm=grounding | ?arm=nongrounding; the link you send IS the assignment
  // 'random' — coin flip per participant
  ARM_ASSIGNMENT: 'url',
};
