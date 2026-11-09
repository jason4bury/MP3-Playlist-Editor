(() => {
  const pw = document.getElementById('pw');
  const toggle = document.getElementById('pw-toggle');
  const err = document.getElementById('err');
  const submit = document.getElementById('submit');

  toggle.addEventListener('click', () => {
    const showing = pw.type === 'text';
    pw.type = showing ? 'password' : 'text';
    toggle.textContent = showing ? '👁' : '🙈';
    toggle.title = showing ? 'Show password' : 'Hide password';
    toggle.setAttribute('aria-label', toggle.title);
    pw.focus();
  });

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        window.location.href = '/';
        return;
      }
      err.textContent = data.error || 'Incorrect password';
      pw.select();
    } catch {
      err.textContent = 'Can\'t reach the server. Is the container running?';
    } finally {
      submit.disabled = false;
    }
  });
})();
