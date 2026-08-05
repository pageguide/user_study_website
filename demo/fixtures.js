// Fixture trajectories for the demo.
// =================================
// Three runs with deliberately different shapes, so the demo exercises the cases that actually
// differ rather than the same task three times:
//
//   1. a clean run          — succeeded, no error. Tests "No error" being an ANSWER, not an absence.
//   2. a run with one error — failed, wrong target at a known step. The ordinary case.
//   3. a text-condition run — no screenshots at all, as GUIDE × TEXT is recorded.
//
// Screenshots are DRAWN, not shipped: a fixture image would be a binary blob in the repo that
// nobody can read a diff of, and a 1×1 pixel proves the slot is wired while showing nothing. These
// are recognisable fake pages, so hovering a step actually shows something that changes per step —
// which is the thing worth looking at in a preview.

/** A fake browser page as a JPEG data URI, minus the data: prefix (the form every shot is in). */
function drawFakePage({ title, rows, highlight, tint = '#7857ff' }) {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 560;
  const x = c.getContext('2d');

  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);

  // Chrome: tab strip and address bar, so it reads as a browser rather than a slide.
  x.fillStyle = '#f1f1f4'; x.fillRect(0, 0, c.width, 64);
  x.fillStyle = '#fff'; x.fillRect(16, 10, 220, 26);
  x.fillStyle = '#dcdce4'; x.fillRect(16, 44, c.width - 32, 12);
  x.fillStyle = '#6b6b76'; x.font = '600 12px -apple-system, sans-serif';
  x.fillText('campusmap.example.edu', 24, 54);

  x.fillStyle = '#16161a'; x.font = '700 26px -apple-system, sans-serif';
  x.fillText(title, 32, 118);

  rows.forEach((row, i) => {
    const y = 158 + i * 62;
    const on = i === highlight;
    x.fillStyle = on ? '#efe9ff' : '#f7f7fa';
    x.fillRect(32, y, c.width - 64, 48);
    if (on) { x.strokeStyle = tint; x.lineWidth = 3; x.strokeRect(32, y, c.width - 64, 48); }
    x.fillStyle = on ? '#4a2fc0' : '#3a3a44';
    x.font = `${on ? 700 : 500} 17px -apple-system, sans-serif`;
    x.fillText(row, 52, y + 31);
  });

  return c.toDataURL('image/jpeg', 0.85).replace(/^data:image\/\w+;base64,/, '');
}

function buildDemoTrajectories() {
  const lots = ['Samford Gravel Lot', 'Library Parking Deck', 'Stadium Lot C', 'Thach Lot'];
  const shot = (n, highlight) => drawFakePage({
    title: `Campus map — step ${n}`,
    rows: lots,
    highlight,
  });

  return [
    // ── 1. A clean run: the agent got it right, no step went wrong. ──
    {
      id: 'demo-clean',
      goal: 'Find the closest parking spot to Samford Hall.',
      title: 'Parking near Samford Hall',
      condition: 'visual',
      ground_truth: {
        correctness: 'success', problems: [], problem: '',
        errors: [], no_error: true,
      },
      arms: {
        grounding: {
          initial_state: { screenshot: shot(0, -1), url: 'https://campusmap.example.edu' },
          final_state: { screenshot: shot(4, 0), url: 'https://campusmap.example.edu?lot=gravel' },
          steps: [
            { n: 1, instruction: "Type 'Samford Hall' into the search bar.", screenshot: shot(1, -1) },
            { n: 2, instruction: "Click the 'Parking' category to show nearby lots.", screenshot: shot(2, -1) },
            { n: 3, instruction: "Click 'Samford Gravel Lot', the nearest marker.", screenshot: shot(3, 0) },
          ],
          answer: 'The closest parking to Samford Hall is the Samford Gravel Lot, about a 2 minute walk.',
          answer_evidence: [], answer_segments: [],
          trail: {
            summary: 'I searched for the building, opened the parking layer and compared the markers by distance.',
            milestones: [
              { step: 2, text: 'Opened the parking layer.' },
              { step: 3, text: 'Picked the nearest lot.' },
            ],
          },
          questions: window.GUIDE_STUDY_QUESTIONS,
        },
        nongrounding: null,
      },
    },

    // ── 2. A failed run: right idea, wrong marker, at a step you can point at. ──
    {
      id: 'demo-wrong-target',
      goal: 'Find the closest parking spot to the RBD Library.',
      title: 'Parking near RBD Library',
      condition: 'visual',
      ground_truth: {
        correctness: 'failure',
        problems: ['hallucinated_result'],
        problem: 'It reported a "Central Parking Deck" that does not appear anywhere on the map.',
        errors: [{ type: 'wrong_target', steps: [3] }],
        no_error: false,
      },
      arms: {
        grounding: {
          initial_state: { screenshot: shot(0, -1), url: 'https://campusmap.example.edu' },
          final_state: { screenshot: shot(4, 2), url: 'https://campusmap.example.edu?lot=stadium' },
          steps: [
            { n: 1, instruction: "Type 'RBD Library' into the search bar.", screenshot: shot(1, -1) },
            { n: 2, instruction: "Click the 'Parking' category to show nearby lots.", screenshot: shot(2, -1) },
            { n: 3, instruction: "Click 'Stadium Lot C' to check its distance.", screenshot: shot(3, 2) },
            { n: 4, instruction: 'Report the parking spot found.', screenshot: shot(4, 2) },
          ],
          answer: 'The closest parking to the RBD Library is the Central Parking Deck, right beside the entrance.',
          answer_evidence: [], answer_segments: [],
          trail: {
            summary: 'I searched for the library, opened the parking layer and selected a nearby lot.',
            milestones: [
              { step: 2, text: 'Opened the parking layer.' },
              { step: 3, text: 'Selected Stadium Lot C.' },
            ],
          },
          questions: window.GUIDE_STUDY_QUESTIONS,
        },
        nongrounding: null,
      },
    },

    // ── 3. The text condition: recorded with no captures at all. ──
    // Its steps carry screenshot:null, which is how a GUIDE × TEXT run is actually stored — the
    // capture is skipped at record time, not stripped afterwards.
    {
      id: 'demo-text',
      goal: 'Add one football ticket for the Auburn vs Samford game, level U section 110.',
      title: 'Buy a football ticket',
      condition: 'text',
      ground_truth: {
        correctness: 'failure', problems: ['incomplete'], problem: '',
        errors: [{ type: 'loop', steps: [3, 4] }],
        no_error: false,
      },
      arms: {
        grounding: {
          initial_state: { screenshot: null, url: 'https://tickets.example.edu' },
          final_state: { screenshot: null, url: 'https://tickets.example.edu/cart' },
          steps: [
            { n: 1, instruction: "Click 'Football' in the sport list.", screenshot: null },
            { n: 2, instruction: "Select the 'Auburn vs Samford' fixture.", screenshot: null },
            { n: 3, instruction: "Open the seating map and look for section 110.", screenshot: null },
            { n: 4, instruction: "Scroll the seating map to find section 110.", screenshot: null },
            { n: 5, instruction: 'Report what was found.', screenshot: null },
          ],
          answer: 'I opened the seating map but could not locate section 110 in level U.',
          answer_evidence: [], answer_segments: [],
          trail: {
            summary: 'I navigated to the fixture and opened the seating map, then searched for the section.',
            milestones: [
              { step: 2, text: 'Opened the fixture.' },
              { step: 4, text: 'Kept scrolling the same map.' },
            ],
          },
          questions: window.GUIDE_STUDY_QUESTIONS,
        },
        nongrounding: null,
      },
    },
  ];
}

window.DemoFixtures = { buildDemoTrajectories };
