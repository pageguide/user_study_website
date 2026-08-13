// Supabase configuration for the PageGuide user study website.
//
// Copy this file to app/config.js (gitignored — never commit real credentials) and fill in your
// own project's URL + anon key. Find these in: Supabase Dashboard → Project Settings → API.
//
// The ANON key is the right key here and the only one that belongs in a browser. It can read the
// stimulus tables and insert results, and nothing else — see the RLS policies in
// ../../pageguide/supabase_schema.sql. The service-role key must NEVER appear in this file: this
// site is served to participants, so anything in it is public.
//
// Without app/config.js the site still loads and will say so plainly rather than failing silently
// with an empty task list.

window.STUDY_CONFIG = {
  SUPABASE_URL: 'YOUR_PROJECT_URL',        // e.g. https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: 'YOUR_PROJECT_ANON_KEY',

  // Which half of the study this deployment runs. The participant site now builds a mixed queue
  // from both halves; this remains for older local/debug tooling.
  HALF: 'guide',

  // Participant assignment is round-robin through Supabase RPC claim_study_assignment:
  // each participant gets 8 tasks, 4 grounded and 4 non-grounded. ARM_ASSIGNMENT is kept only for
  // older debug/admin paths that still need a single fallback arm.
  ASSIGNMENT_KEY: 'default',
  ARM_ASSIGNMENT: 'url',

  // The questionnaire shown on the final screen, after the eighth task. OPTIONAL — app/study.js
  // carries the study's own form as its default, so leaving this out is the normal case. Set it
  // only when a deployment needs a different form; the value must be a Google Forms /viewform URL,
  // which is what the final screen embeds and links to.
  // POST_SURVEY_URL: 'https://docs.google.com/forms/d/e/…/viewform',
};
