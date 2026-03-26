/**
 * OrbitAds Popup
 * ───────────────
 * Handles three states:
 *   1. Not logged in → show login form
 *   2. Logged in, queue empty → show empty state
 *   3. Logged in, queue has items → show queue with progress
 *
 * Reads queue from chrome.storage.local (set by background.js)
 * Polls for updates every 2 seconds while popup is open
 */

// ── Config ────────────────────────────────────────────────────
// Change to https://api.dealersorbit.com when deployed
const API_BASE = "http://localhost:8000/api/v1";


// ── Elements ──────────────────────────────────────────────────
const loginScreen  = document.getElementById("loginScreen");
const emptyScreen  = document.getElementById("emptyScreen");
const queueScreen  = document.getElementById("queueScreen");
const userInfo     = document.getElementById("userInfo");
const userName     = document.getElementById("userName");
const loginError   = document.getElementById("loginError");
const loginBtn     = document.getElementById("loginBtn");
const logoutBtn    = document.getElementById("logoutBtn");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const jobList      = document.getElementById("jobList");
const queueCount   = document.getElementById("queueCount");


// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { token, user } = await chrome.storage.local.get(["token", "user"]);

  if (token && user) {
    showLoggedIn(user);
    renderQueue();
    // Poll for queue updates every 2 seconds
    setInterval(renderQueue, 2000);
  } else {
    showScreen(loginScreen);
  }
}


// ── Screen management ─────────────────────────────────────────
function showScreen(screen) {
  [loginScreen, emptyScreen, queueScreen].forEach(s => s.style.display = "none");
  screen.style.display = "block";
}

function showLoggedIn(user) {
  userInfo.style.display = "flex";
  userName.textContent   = user.full_name?.split(" ")[0] || user.email;
}


// ── Login ─────────────────────────────────────────────────────
loginBtn.addEventListener("click", async () => {
  const email    = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  loginError.textContent = "";

  if (!email || !password) {
    loginError.textContent = "Please enter your email and password.";
    return;
  }

  loginBtn.textContent = "Signing in...";
  loginBtn.disabled    = true;

  try {
    // OAuth2 password flow — same as Swagger login
    const formData = new URLSearchParams();
    formData.append("username", email);
    formData.append("password", password);

    const resp = await fetch(`${API_BASE}/auth/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    formData,
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || "Login failed.");
    }

    const { access_token } = await resp.json();

    // Fetch user profile
    const userResp = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${access_token}` },
    });
    const user = await userResp.json();

    // Save to extension storage
    await chrome.storage.local.set({ token: access_token, user });

    showLoggedIn(user);
    renderQueue();
    setInterval(renderQueue, 2000);

  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.textContent = "Sign In";
    loginBtn.disabled    = false;
  }
});

// Allow Enter key to submit
document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});


// ── Logout ────────────────────────────────────────────────────
logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(["token", "user"]);
  userInfo.style.display = "none";
  showScreen(loginScreen);
});


// ── Clear completed jobs ──────────────────────────────────────
clearDoneBtn.addEventListener("click", async () => {
  const { queue = [] } = await chrome.storage.local.get("queue");
  const filtered = queue.filter(j => j.status !== "completed" && j.status !== "failed");
  await chrome.storage.local.set({ queue: filtered });
  renderQueue();
});


// ── Queue rendering ───────────────────────────────────────────
async function renderQueue() {
  const { queue = [] } = await chrome.storage.local.get("queue");

  if (queue.length === 0) {
    showScreen(emptyScreen);
    return;
  }

  showScreen(queueScreen);

  const waiting    = queue.filter(j => j.status === "waiting").length;
  const generating = queue.filter(j => j.status === "generating").length;
  const completed  = queue.filter(j => j.status === "completed").length;
  const failed     = queue.filter(j => j.status === "failed").length;

  queueCount.textContent = `${queue.length} vehicle${queue.length !== 1 ? "s" : ""} — ` +
    [
      generating ? `${generating} generating` : "",
      waiting    ? `${waiting} waiting`    : "",
      completed  ? `${completed} done`     : "",
      failed     ? `${failed} failed`      : "",
    ].filter(Boolean).join(", ");

  jobList.innerHTML = queue.map(job => renderJobCard(job)).join("");
}


function renderJobCard(job) {
  const v     = job.vehicle;
  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  const meta  = [v.mileage, v.vin ? `VIN: ${v.vin}` : null]
    .filter(Boolean).join(" · ");

  let badgeClass = "badge-waiting";
  let badgeText  = "Waiting";
  if (job.status === "generating") { badgeClass = "badge-generating"; badgeText = "Generating"; }
  if (job.status === "completed")  { badgeClass = "badge-done";       badgeText = "Done ✓"; }
  if (job.status === "failed")     { badgeClass = "badge-failed";     badgeText = "Failed"; }

  const progressBarClass = job.status === "completed" ? "done" :
                           job.status === "failed"    ? "failed" : "";

  const actionsHtml = job.status === "completed" && job.result_url
    ? `<div class="job-actions">
         <a href="${job.result_url}" target="_blank" class="btn-small">▶ View Ad</a>
       </div>`
    : job.status === "failed" && job.error
    ? `<div class="job-label" style="color:#dc2626">${job.error}</div>`
    : "";

  return `
    <div class="job-card">
      <div class="job-top">
        <div class="job-title">${title || "Unknown Vehicle"}</div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      ${meta ? `<div class="job-meta">${meta}</div>` : ""}
      ${v.price ? `<div class="job-price">${v.price}</div>` : ""}
      <div class="progress-wrap">
        <div class="progress-bar ${progressBarClass}" 
             style="width: ${job.progress || 0}%"></div>
      </div>
      <div class="job-label">${job.label || ""}</div>
      ${actionsHtml}
    </div>
  `;
}


// ── Start ──────────────────────────────────────────────────────
init();