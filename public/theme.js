(() => {
  const root = document.documentElement;
  // Keep the saved preference from the earlier sidebar-only setting.
  const key = 'tx-sidebar-style';
  try {
    if (localStorage.getItem(key) === 'dark') root.dataset.theme = 'dark';
  } catch {}
  const colorKeys = {accent: 'tx-accent-color', qr: 'tx-qr-color'};
  const defaults = {accent: '#d90019', qr: '#000000'};
  const colors = {...defaults};
  const validColor = value => /^#[0-9a-f]{6}$/i.test(value);
  function applyAccent(color) {
    const custom = color !== defaults.accent;
    root.toggleAttribute('data-custom-accent', custom);
    root.style.setProperty('--tx-custom-accent', custom ? color : '');
    const [r,g,b] = color.slice(1).match(/../g).map(hex => {
      const value = parseInt(hex, 16) / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    });
    const lightInk = .2126*r + .7152*g + .0722*b < .179;
    root.style.setProperty('--tx-custom-ink', custom ? (lightInk ? '#fff' : '#000') : '');
  }
  for (const type of Object.keys(colors)) {
    try {
      const saved = localStorage.getItem(colorKeys[type]);
      if (validColor(saved)) colors[type] = saved.toLowerCase();
    } catch {}
  }
  applyAccent(colors.accent);
  window.trainerXColors = {
    get: type => colors[type],
    set(type, value) {
      if (!Object.hasOwn(colors, type) || !validColor(value)) return;
      colors[type] = value.toLowerCase();
      try { localStorage.setItem(colorKeys[type], colors[type]); } catch {}
      if (type === 'accent') applyAccent(colors.accent);
      if (type === 'qr') window.dispatchEvent(new Event('trainerx-qr-color'));
    },
    reset(type) { this.set(type, defaults[type]); }
  };
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
