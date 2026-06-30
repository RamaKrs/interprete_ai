const DASHBOARD_URL = 'http://localhost:8766';

// ── Sync UI with current state ──────────────────
async function init() {
  const { isCapturing } = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  setUI(isCapturing);
}

function setUI(capturing) {
  document.getElementById('startBtn').disabled = capturing;
  document.getElementById('stopBtn').disabled = !capturing;
  document.getElementById('statusPill').textContent = capturing ? 'Live' : 'Idle';
  document.getElementById('statusPill').className = 'status-pill' + (capturing ? ' live' : '');
  document.getElementById('logoDot').className = 'logo-dot' + (capturing ? ' recording' : '');
}

// ── Start: capture + open dashboard ────────────
document.getElementById('startBtn').addEventListener('click', async () => {
  document.getElementById('startBtn').disabled = true;

  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({}, (id) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(id);
      });
    });

    const response = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId
    });

    if (response?.success) {
      setUI(true);
      // Open dashboard in a new tab — user can pop it out as an app
      chrome.tabs.create({ url: DASHBOARD_URL });
    } else {
      document.getElementById('startBtn').disabled = false;
      console.error('Start failed:', response?.error);
    }
  } catch (err) {
    document.getElementById('startBtn').disabled = false;
    console.error('Error:', err);
  }
});

// ── Stop ────────────────────────────────────────
document.getElementById('stopBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  setUI(false);
});

// ── Open dashboard without starting capture ─────
document.getElementById('dashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});

init();