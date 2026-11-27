(() => {
  const root = document.documentElement;
  // Keep the saved preference from the earlier sidebar-only setting.
  const key = 'tx-sidebar-style';
  try {
    if (localStorage.getItem(key) === 'dark') root.dataset.theme = 'dark';
  } catch {}
  const colorKeys = {accent: 'tx-accent-color', qr: 'tx-qr-color'};
  const defaults = {accent: '#d90019', qr: '#000000'};
  const presets = [
    {id:'minimal-green', name:'Minimal Green', shades:['#051f20','#0b2b26','#163832','#235347','#8eb69b','#daf1de']},
    {id:'steel-blue', name:'Steel Blue', shades:['#06141b','#11212d','#253745','#4a5c6a','#9ba8ab','#ccd0cf']},
    {id:'warm-earth', name:'Warm Earth', shades:['#291c0e','#6e473b','#a78d78','#beb5a9','#e1d4c2']},
    {id:'gold', name:'Gold', shades:['#5a4a0d','#7a5e12','#a67917','#cc961f','#e8b84a','#f3d789','#fff3d8']},
    {id:'sky-blue', name:'Sky Blue', shades:['#04202e','#0a3c55','#0f5e83','#1786b4','#4fb3da','#98d5ee','#e1f2fa']},
    {id:'lime', name:'Lime', shades:['#1f2a05','#3d520b','#648215','#8fb61f','#b4d944','#d6ee8d','#f1fbd3']},
    {id:'neon-green', name:'Neon Green', shades:['#0f0f0f','#202020','#337418','#5dd62c','#f8f8f8']},
    {id:'purple-lime', name:'Purple & Lime', shades:['#3c1a47','#624070','#719500','#b6ff00','#d8f49f','#f2ebf5']}
  ];
  const presetKey = 'tx-accent-preset';
  let selectedPreset;
  function applyPreset(preset) {
    selectedPreset = preset;
    if (!preset) {
      root.removeAttribute('data-accent-preset');
      applyAccent(colors.accent);
      return;
    }
    root.dataset.accentPreset = preset.id;
    root.removeAttribute('data-custom-accent');
    const shades = preset.shades;
    const [deep, dark, medium, vivid] = shades;
    const pale = shades.at(-1), soft = shades.at(-2);
    const bright = shades.length === 7 ? shades[4] : soft;
    for (const [tone,color] of Object.entries({deep,dark,medium,vivid,bright,soft,pale})) {
      root.style.setProperty('--preset-'+tone,color);
    }
  }
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
  try {
    const savedPreset = localStorage.getItem(presetKey);
    selectedPreset = presets.find(preset => preset.id === savedPreset);
  } catch {}
  applyPreset(selectedPreset);
  window.trainerXColors = {
    get: type => type === 'accent' && selectedPreset ? selectedPreset.shades[3] : colors[type],
    presets: () => presets,
    selectedPreset: () => selectedPreset?.id,
    selectPreset(id) {
      const preset = presets.find(item => item.id === id);
      if (!preset) return;
      try { localStorage.setItem(presetKey,preset.id); } catch {}
      applyPreset(preset);
      updateBrowserColor();
    },
    set(type, value) {
      if (!Object.hasOwn(colors, type) || !validColor(value)) return;
      colors[type] = value.toLowerCase();
      try { localStorage.setItem(colorKeys[type], colors[type]); } catch {}
      if (type === 'accent') {
        try { localStorage.removeItem(presetKey); } catch {}
        applyPreset();
        updateBrowserColor();
      }
      if (type === 'qr') window.dispatchEvent(new Event('trainerx-qr-color'));
    },
    reset(type) { this.set(type, defaults[type]); }
  };
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const updateBrowserColor = () => {
    const dark = root.dataset.theme === 'dark';
    themeColor.content = selectedPreset ? selectedPreset.shades.at(dark ? 0 : -1) : dark ? '#15161c' : '#d5d7db';
  };
  updateBrowserColor();
  window.setTrainerXTheme = theme => {
    root.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    try { localStorage.setItem(key, root.dataset.theme); } catch {}
    updateBrowserColor();
  };
})();
