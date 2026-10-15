'use strict';
(() => {
  const api = window.extApi;
  const $ = (id) => document.getElementById(id);
  const msg = (t, kind) => {
    $('msg').textContent = t || '';
    $('msg').className = kind || '';
  };

  let state = { enabled: false };

  function render() {
    const chip = $('chip');
    $('toggle').textContent = state.enabled ? 'Turn off' : 'Turn on';
    $('toggle').classList.toggle('off', !!state.enabled); // turning off is the quieter choice
    $('folder').disabled = !state.enabled;
    $('token').disabled = !state.enabled;
    chip.hidden = false;
    if (!state.enabled) {
      $('status').textContent = 'The link is off. Nothing is listening.';
      chip.className = 'chip neutral';
      chip.textContent = 'Off';
    } else if (state.seen) {
      const ago = Math.max(0, Math.round((Date.now() - state.seen.at) / 1000));
      $('status').textContent = `Last tab seen: ${state.seen.host || 'a browser page'}, ${ago < 90 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago.`;
      chip.className = ago < 120 ? 'chip on' : 'chip neutral';
      chip.textContent = ago < 120 ? 'Connected' : 'Quiet';
    } else {
      $('status').textContent = state.port ? `Listening on port ${state.port}. No browser has reported in yet.` : 'Starting…';
      chip.className = 'chip neutral';
      chip.textContent = 'Waiting';
    }
  }

  async function refresh() {
    try {
      state = (await api.get()) || state;
    } catch (e) {
      /* window closing */
    }
    render();
  }

  $('toggle').addEventListener('click', async () => {
    state = (await api.setEnabled(!state.enabled)) || state;
    msg(state.enabled ? 'On. Now add the extension to your browser.' : 'Off.');
    render();
  });
  $('folder').addEventListener('click', async () => {
    const res = await api.openFolder();
    msg(res && res.ok ? 'Folder opened. Load it as an unpacked extension.' : 'Could not open the folder.', res && res.ok ? 'good' : 'error');
  });
  $('token').addEventListener('click', async () => {
    if (!window.confirm('Make a new secret? You will need to reload the extension in your browser afterwards.')) return;
    const res = await api.newToken();
    msg(res && res.ok ? 'New secret written. Reload the extension in your browser.' : 'Could not write the new secret.', res && res.ok ? 'good' : 'error');
  });

  refresh();
  setInterval(refresh, 2000);
})();
