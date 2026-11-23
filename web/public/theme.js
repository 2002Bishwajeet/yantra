// shell/prefs.ts's key, read before the first paint so the theme and density
// do not land a frame late. A file, because the daemon's policy runs no inline script.
try {
  var p = JSON.parse(localStorage.getItem('yantra.prefs'))
  if (p && p.v === 1) {
    if (p.theme === 'light' || p.theme === 'dark') {
      document.documentElement.dataset.theme = p.theme
      document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
        m.media = m.dataset.scheme === p.theme ? 'all' : 'not all'
      })
    }
    if (p.density === 'compact') document.documentElement.dataset.density = 'compact'
  }
} catch {
  // A blocked store or a broken value is no preference.
}
