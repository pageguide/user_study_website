// A drawn browser screenshot.
// ===========================
// Shared by the demo fixtures and the tutorial's practice trajectory. Screenshots are DRAWN, not
// shipped: a fixture image would be a binary blob in the repo that nobody can read a diff of, and a
// 1×1 pixel proves the slot is wired while showing nothing. These are recognisable fake pages, so
// hovering a step actually shows something that changes per step — which is the thing worth looking
// at in a preview, and the thing the tutorial is teaching someone to look at.

/** A fake browser page as a JPEG data URI, minus the data: prefix (the form every shot is in). */
function drawFakePage({ title, rows, highlight, tint = '#7857ff', host = 'campusmap.example.edu' }) {
  const c = document.createElement('canvas');
  c.width = 900; c.height = 560;
  const x = c.getContext('2d');

  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);

  // Chrome: tab strip and address bar, so it reads as a browser rather than a slide.
  x.fillStyle = '#f1f1f4'; x.fillRect(0, 0, c.width, 64);
  x.fillStyle = '#fff'; x.fillRect(16, 10, 220, 26);
  x.fillStyle = '#dcdce4'; x.fillRect(16, 44, c.width - 32, 12);
  x.fillStyle = '#6b6b76'; x.font = '600 12px -apple-system, sans-serif';
  x.fillText(host, 24, 54);

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

window.FakePage = { drawFakePage };
