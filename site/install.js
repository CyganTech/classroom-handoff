const backend = document.getElementById('backend');
const policy = document.getElementById('policy');
const error = document.getElementById('error');
const download = document.getElementById('download');
backend.addEventListener('input', () => {
  try {
    const u = new URL(backend.value.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Enter an HTTPS origin only, without a path or credentials.');
    policy.value = JSON.stringify({ BackendUrl: { Value: u.origin }, AutoRegister: { Value: true } }, null, 2);
    error.textContent = ''; download.disabled = false;
  } catch (e) { policy.value = ''; download.disabled = true; error.textContent = backend.value ? e.message : ''; }
});
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([policy.value + '\n'], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'classroom-handoff-policy.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
