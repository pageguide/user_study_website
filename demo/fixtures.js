// Fixture trajectories for the demo.
// =================================
// Three runs with deliberately different shapes, so the demo exercises the cases that actually
// differ rather than the same task three times:
//
//   1. a clean run          — succeeded, no error. Tests "No error" being an ANSWER, not an absence.
//   2. a run with one error — failed, wrong target at a known step. The ordinary case.
//   3. a text-condition run — no screenshots at all, as GUIDE × TEXT is recorded.
//
// Screenshots are DRAWN, not shipped — see app/fake_page.js, which the tutorial's practice
// trajectory draws its pages with too.

function buildDemoTrajectories() {
  const lots = ['Samford Gravel Lot', 'Library Parking Deck', 'Stadium Lot C', 'Thach Lot'];
  const shot = (n, highlight) => window.FakePage.drawFakePage({
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
