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

  // Which half of the study this deployment runs. 'guide' is what the site currently implements.
  HALF: 'guide',

  // How a participant is assigned to an arm:
  //   'random'  — coin flip on the welcome screen (between-subjects)
  //   'url'     — read ?arm=grounding|nongrounding, so you control assignment when recruiting
  //   'ask'     — a picker on the welcome screen (debugging and pilots only; a real participant
  //               must never choose their own condition)
  ARM_ASSIGNMENT: 'url',
};
