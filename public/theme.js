(() => {
  const root = document.documentElement;
  // Keep the saved preference from the earlier sidebar-only setting.
  const key = 'tx-sidebar-style';
  try {
    if (localStorage.getItem(key) === 'dark') root.dataset.theme = 'dark';
  } catch {}
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const updateBrowserColor = () => {
    themeColor.content = root.dataset.theme === 'dark' ? '#15161c' : '#d5d7db';
  };
  updateBrowserColor();
  window.setTrainerXTheme = theme => {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(key, root.dataset.theme); } catch {}
    updateBrowserColor();
  };
})();
