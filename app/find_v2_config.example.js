// Find V2 uses a separate Supabase project from the original PageGuide study.
// Copy this file to `app/find_v2_config.js`, then paste the Project URL and
// publishable/anon key from the NEW project's Settings → API page.
//
// Never put a secret/service-role key in this file. It is served to every
// participant. Admin writes are authorized by the password configured through
// `set_pageguide_find_v2_admin_password(...)` in supabase_find_v2.sql.
window.FIND_V2_CONFIG = {
  SUPABASE_URL: 'YOUR_FIND_V2_SUPABASE_URL',
  SUPABASE_ANON_KEY: 'YOUR_FIND_V2_SUPABASE_ANON_KEY',

  // The questionnaire shown on the final screen. Optional: app/study.js commits the study's own
  // form, so a deployment cloned fresh still ends where it should — this only overrides it. Use the
  // long docs.google.com/forms/d/e/…/viewform address rather than a forms.gle short link: the short
  // one is a redirect, and a redirect drops the `?embedded=true` the inline frame needs.
  // POST_SURVEY_URL: 'https://docs.google.com/forms/d/e/…/viewform',
};

