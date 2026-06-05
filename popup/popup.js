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
// ── Config ────────────────────────────────────────────────────
const API_BASE = "https://api.dealersorbit.com/api/v1";

// ── Elements ──────────────────────────────────────────────────
const dashboardScreen = document.getElementById("dashboardScreen");
const reviewQueueContainer = document.getElementById("reviewQueueCards") || document.createElement("div"); const settingsScreen = document.getElementById("settingsScreen");
const settingsBackBtn = document.getElementById("settingsBackBtn");
const settingsBtn = document.getElementById("settingsBtn");
const helpBtn = document.getElementById("helpBtn");
const siteBtn = document.getElementById("siteBtn");
const signOutBtn = document.getElementById("signOutBtn");
const statAdsToday = document.getElementById("statAdsToday");
const statAdsWeek = document.getElementById("statAdsWeek");
const statAdsTotal = document.getElementById("statAdsTotal");
const statFbPosted = document.getElementById("statFbPosted");
const queueEmpty = document.getElementById("queueEmpty");
const recentAds = document.getElementById("recentAds");
const videoTypeSelectDash = document.getElementById("videoTypeSelectDash");
const loginScreen = document.getElementById("loginScreen");
const emptyScreen = document.getElementById("emptyScreen");
const userInfo = document.getElementById("userInfo");
const userName = document.getElementById("userName");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn") || document.createElement("button");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const jobList = document.getElementById("jobList");
const queueCount = document.getElementById("queueCount");
const backBtn = document.getElementById("backBtn");
const reviewScreen = document.getElementById("reviewScreen");
const reviewTitle = document.getElementById("reviewTitle");
const reviewMeta = document.getElementById("reviewMeta");
const reviewStatus = document.getElementById("reviewStatus");
const reviewSections = document.getElementById("reviewSections");
const generateBtn = document.getElementById("generateBtn") || document.createElement("button");
const uploadInput = document.getElementById("uploadInput");
const facebookBtn = document.getElementById("facebookBtn") || document.createElement("button");
const fbSuccessBanner = document.getElementById("fbSuccessBanner");
const fbListingScreen = document.getElementById("fbListingScreen") || document.createElement("div");
const fbBackBtn = document.getElementById("fbBackBtn") || document.createElement("button");
const fbListingTitle = document.getElementById("fbListingTitle") || document.createElement("div");
const fbListingMeta = document.getElementById("fbListingMeta") || document.createElement("div");
const fbTitleText = document.getElementById("fbTitleText") || document.createElement("div");
const fbPriceText = document.getElementById("fbPriceText") || document.createElement("div");
const fbDescText = document.getElementById("fbDescText") || document.createElement("div");
const fbTagsWrap = document.getElementById("fbTagsWrap") || document.createElement("div");
const fbPostingStatus = document.getElementById("fbPostingStatus") || document.createElement("div");
const fbStatusLabel = document.getElementById("fbStatusLabel") || document.createElement("div");
const fbQueueList = document.getElementById("fbQueueList") || document.createElement("div");
const openFbBtn = document.getElementById("openFbBtn") || document.createElement("button");
const copyAllBtn = document.getElementById("copyAllBtn") || document.createElement("button");
const generateModal = document.getElementById("generateModal");
const closeModal = document.getElementById("closeModal");
const modalStep1 = document.getElementById("modalStep1");
const modalStep2 = document.getElementById("modalStep2");
const modalStep3 = document.getElementById("modalStep3");
const modalStep4 = document.getElementById("modalStep4");
const modalStepOutro = document.getElementById("modalStepOutro");
const modalVehicleTitle = document.getElementById("modalVehicleTitle");
const soldModal = document.getElementById("soldModal");
const soldCheckerStat = document.getElementById("soldCheckerStat");
const statSoldCount = document.getElementById("statSoldCount");

// ── Session helpers ───────────────────────────────────────────
async function handleSessionExpired() {
  if (queueInterval) { clearInterval(queueInterval); queueInterval = null; }
  await chrome.storage.local.remove(["token", "user"]);
  userInfo.style.display = "none";
  loginError.textContent = "Your session has expired. Please sign in again.";
  showScreen(loginScreen);
}

// Drop-in replacement for fetch() on authenticated calls.
// Intercepts 401 responses and logs the user out automatically.
async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  if (resp.status === 401) {
    await handleSessionExpired();
    throw new Error("session_expired");
  }
  return resp;
}

// ── State ──────────────────────────────────────────────────────
let currentFbListing = null;
let queueInterval = null;
let reviewPhotos = { exterior: [], interior: [], additional: [], other: [] };
let reviewVehicle = null;
let activeJobPolling = false;
let modalSelectedType = null;
let modalSelectedTheme = null;
let modalVehicle = null;
let modalSelectedOutroId = null;
let modalQueueItemId = null;

// ... rest of the file (all functions and event listeners)
// ... init() call stays at the very bottom

// Sold checker stat click
soldCheckerStat?.addEventListener("click", async () => {
  const modal = document.getElementById("soldModal");
  if (!modal) return;
  modal.style.display = "flex";

  // Attach close handler here so modal exists
  document.getElementById("closeSoldModal").onclick = () => {
    modal.style.display = "none";
  };

  await loadSoldModalContent();
});


async function loadSoldModalContent() {
  const content = document.getElementById("soldModalContent");
  content.innerHTML = `<p style="color:#6b7280;font-size:13px;text-align:center">
    🔍 Checking listings...</p>`;

  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    content.innerHTML = `<p style="color:#dc2626">Please sign in first.</p>`;
    return;
  }

  try {
    // Get listings from backend
    const resp = await apiFetch(`${API_BASE}/listings/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed");

    const listings = await resp.json();
    const posted = listings.filter(l => l.fb_posted);
    const sold = listings.filter(l => l.is_sold);
    const active = posted.filter(l => !l.is_sold);

    if (posted.length === 0) {
      content.innerHTML = `
        <p style="font-size:13px;color:#6b7280;text-align:center;padding:16px">
          No Facebook listings found yet.<br>
          Post a vehicle to Facebook first.
        </p>`;
      return;
    }

    // Trigger a fresh check
    const activeIds = active.map(l => l.id);
    if (activeIds.length > 0) {
      const checkResp = await apiFetch(`${API_BASE}/listings/check-sold`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ listing_ids: activeIds }),
      });

      if (checkResp.ok) {
        const { sold_ids } = await checkResp.json();
        if (sold_ids.length > 0) {
          // Refresh listings after check
          const refreshResp = await apiFetch(`${API_BASE}/listings/`, {
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (refreshResp.ok) {
            const refreshed = await refreshResp.json();
            content.innerHTML = renderSoldModalContent(refreshed);
            updateSoldStat(refreshed);
            return;
          }
        }
      }
    }

    content.innerHTML = renderSoldModalContent(listings);
    updateSoldStat(listings);

  } catch (err) {
    content.innerHTML = `<p style="color:#dc2626;font-size:13px">
      Failed to check listings. Please try again.</p>`;
  }
}

function renderSoldModalContent(listings) {
  const sold = listings.filter(l => l.is_sold);
  const active = listings.filter(l => l.fb_posted && !l.is_sold);

  let html = "";

  if (sold.length > 0) {
    html += `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#dc2626;
                  text-transform:uppercase;margin-bottom:8px">
        🚨 May Be Sold (${sold.length})
      </div>`;
    sold.forEach(l => {
      const title = [l.year, l.make?.toUpperCase(), l.model].filter(Boolean).join(" ");
      html += `<div class="recent-ad-card" style="border-left:3px solid #dc2626">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title}</div>
          <div class="recent-ad-meta">${l.price || ""} · Remove from Facebook</div>
        </div>
        <span class="recent-ad-sold">Sold</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (active.length > 0) {
    html += `<div>
      <div style="font-size:12px;font-weight:700;color:#16a34a;
                  text-transform:uppercase;margin-bottom:8px">
        ✓ Still Active (${active.length})
      </div>`;
    active.forEach(l => {
      const title = [l.year, l.make?.toUpperCase(), l.model].filter(Boolean).join(" ");
      html += `<div class="recent-ad-card" style="border-left:3px solid #16a34a">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title}</div>
          <div class="recent-ad-meta">${l.price || ""}</div>
        </div>
        <span style="color:#16a34a;font-size:11px;font-weight:600">Active</span>
      </div>`;
    });
    html += `</div>`;
  }

  if (sold.length === 0 && active.length === 0) {
    html = `<p style="font-size:13px;color:#6b7280;text-align:center;padding:16px">
      No posted listings found.</p>`;
  }

  return html;
}

function updateSoldStat(listings) {
  const soldCount = listings.filter(l => l.is_sold).length;
  if (statSoldCount) {
    statSoldCount.textContent = soldCount > 0 ? soldCount : "✓";
  }
  if (soldCheckerStat) {
    soldCheckerStat.classList.toggle("has-sold", soldCount > 0);
  }
  // Clear badge if no sold
  if (soldCount === 0) {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Delegated click handler for job list — handles dynamically rendered cards
document.getElementById("jobList")?.addEventListener("click", async (e) => {
  // Generate Ad button
  const generateBtn = e.target.closest(".generate-btn");
  if (generateBtn && !generateBtn.disabled) {
    const vin = generateBtn.dataset.vin;
    const model = generateBtn.dataset.model;
    const queueItemId = generateBtn.dataset.queueItemId;

    const { pending_review_queue = [] } =
      await chrome.storage.local.get("pending_review_queue");

    const item = pending_review_queue.find(i =>
      (queueItemId && i.queue_item_id === queueItemId) ||
      (vin && i.vehicle?.vin === vin)
    );

    if (!item) return;

    reviewVehicle = item.vehicle;
    modalQueueItemId = item.queue_item_id || null;

    if (item.classified) {
      reviewPhotos = buildReviewPhotos(
        item.classified,
        item.photos_all || item.vehicle?.photos || [],
        item.blocked_photos || [],
        item.explicit_other || []
      );
    } else if (item.review_photos) {
      reviewPhotos = item.review_photos;
    } else {
      reviewPhotos = { exterior: [], interior: [], additional: [], other: [] };
    }

    console.log("OrbitAds: reviewPhotos for modal:", {
      exterior: reviewPhotos.exterior?.length,
      interior: reviewPhotos.interior?.length,
      additional: reviewPhotos.additional?.length,
    });
    showGenerateModal(item.vehicle);
    return;
  }

  // Post to FB button
  const postFbBtn = e.target.closest(".post-fb-from-queue");
  if (postFbBtn) {
    postFbBtn.dispatchEvent(new CustomEvent("post-fb-click", { bubbles: false }));
    return;
  }

  // Remove failed button
  const removeBtn = e.target.closest(".remove-failed-btn");
  if (removeBtn) {
    const jobId = removeBtn.dataset.jobId;
    const { queue = [] } = await chrome.storage.local.get("queue");
    await chrome.storage.local.set({ queue: queue.filter(j => j.id !== jobId) });
    renderQueue();
    return;
  }

  // Per-card clear button
  const clearBtn = e.target.closest(".clear-card-btn");
  if (clearBtn) {
    const card = clearBtn.closest(".job-card");
    if (!card) return;
    const type = card.dataset.type;
    const jobId = card.dataset.jobId;
    const vin = card.dataset.vin;
    const model = card.dataset.model;

    if (type === "review") {
      const { pending_review_queue = [] } = await chrome.storage.local.get("pending_review_queue");
      const updated = pending_review_queue.filter(i =>
        vin ? i.vehicle?.vin !== vin : i.vehicle?.model !== model
      );
      await chrome.storage.local.set({ pending_review_queue: updated });
      chrome.action.setBadgeText({ text: updated.length > 0 ? String(updated.length) : "" });
    } else {
      const { queue = [] } = await chrome.storage.local.get("queue");
      await chrome.storage.local.set({ queue: queue.filter(j => j.id !== jobId) });
    }
    renderQueue();
    return;
  }

  // Card body click — open review screen
  const card = e.target.closest(".job-card");
  if (card && e.target.tagName !== "BUTTON" && e.target.tagName !== "A") {
    const type = card.dataset.type;
    const vin = card.dataset.vin;
    const model = card.dataset.model;
    const jobId = card.dataset.jobId;
    const queueItemId = card.dataset.queueItemId;

    if (type === "review") {
      const { pending_review_queue = [] } =
        await chrome.storage.local.get("pending_review_queue");
      // Match by queue_item_id first (exact), then VIN, never by model alone
      const item = pending_review_queue.find(i =>
        (queueItemId && i.queue_item_id === queueItemId) ||
        (vin && i.vehicle?.vin === vin)
      );
      if (item) {
        reviewVehicle = item.vehicle;
        reviewPhotos = item.review_photos || {
          exterior: item.classified?.exterior || [],
          interior: item.classified?.interior || [],
          additional: item.classified?.additional || [],
          other: item.classified?.other || [],
        };
        showReviewScreen(item);
      }
    } else if (type === "job") {
      // Show completed job photos
      const { queue = [] } = await chrome.storage.local.get("queue");
      const job = queue.find(j => j.id === jobId);
      if (!job) return;

      const photosForVideo = job.vehicle.photos_for_video || [];
      const allPhotos = job.vehicle.photos || [];
      const videoPhotoSet = new Set(photosForVideo);
      const remainingPhotos = allPhotos.filter(url => !videoPhotoSet.has(url));

      reviewVehicle = job.vehicle;
      reviewPhotos = {
        exterior: photosForVideo.slice(0, 6),
        interior: photosForVideo.slice(6, 8),
        additional: photosForVideo.slice(8),
        other: remainingPhotos,
      };

      showReviewScreen({
        vehicle: job.vehicle,
        photos_all: allPhotos,
        view_only: true,
        completed_job: job,
        classified: { exterior: photosForVideo.slice(0, 6), interior: photosForVideo.slice(6, 8), additional: photosForVideo.slice(8), other: [] },
        review_photos: reviewPhotos,
      });
    }
  }
});

settingsBtn?.addEventListener("click", () => showScreen(settingsScreen));
settingsBackBtn?.addEventListener("click", () => showScreen(dashboardScreen));
helpBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://dealersorbit.com/help" });
});
siteBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://dealersorbit.com" });
});
signOutBtn?.addEventListener("click", async () => {
  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
  }
  await chrome.storage.local.remove(["token", "user"]);
  userInfo.style.display = "none";
  showScreen(loginScreen);
});

// Settings screen populate
async function showSettingsScreen() {
  const { user } = await chrome.storage.local.get("user");
  if (user) {
    document.getElementById("settingsEmail").textContent = user.email || "";
    document.getElementById("settingsDealership").textContent = user.dealership_name || "";
    document.getElementById("voiceIdInput").value = user.elevenlabs_voice_id || "";
  }
  showScreen(settingsScreen);
  loadOutroSettings();
}

settingsBtn?.addEventListener("click", showSettingsScreen);

document.getElementById("saveSettingsBtn")?.addEventListener("click", async () => {
  const { token } = await chrome.storage.local.get("token");
  const voiceId = document.getElementById("voiceIdInput").value.trim();
  const phone = document.getElementById("phoneInput")?.value.trim();

  const resp = await apiFetch(`${API_BASE}/auth/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      elevenlabs_voice_id: voiceId || null,
      phone_number: phone || null,
    }),
  });

  if (resp.ok) {
    const updated = await resp.json();
    await chrome.storage.local.set({ user: updated });
    document.getElementById("settingsSaved").style.display = "block";
    setTimeout(() => {
      document.getElementById("settingsSaved").style.display = "none";
    }, 2000);
  }
});

// ── Outro settings ────────────────────────────────────────────
async function loadOutroSettings() {
  const list = document.getElementById("outroSettingsList");
  if (!list) return;
  list.innerHTML = `<p style="color:#9ca3af;font-size:12px;text-align:center;padding:8px">Loading...</p>`;

  const { token } = await chrome.storage.local.get("token");
  try {
    const resp = await apiFetch(`${API_BASE}/outros/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed");
    const outros = await resp.json();

    if (outros.length === 0) {
      list.innerHTML = `<p style="color:#9ca3af;font-size:12px;text-align:center;padding:8px">No outro videos yet.</p>`;
      return;
    }

    list.innerHTML = outros.map(o => `
      <div class="outro-saved-item">
        <span class="outro-saved-name">${o.name}</span>
        <div class="outro-saved-actions">
          <a href="${o.url}" target="_blank" class="btn-small">Preview</a>
          <button class="btn-small outro-delete-btn" data-id="${o.id}"
                  style="background:#fee2e2;color:#dc2626">Delete</button>
        </div>
      </div>`).join("");

  } catch (err) {
    if (err.message === "session_expired") return;
    list.innerHTML = `<p style="color:#dc2626;font-size:12px">Failed to load. Please try again.</p>`;
  }
}

document.getElementById("uploadOutroBtn")?.addEventListener("click", async () => {
  const fileInput = document.getElementById("outroFileInput");
  const nameInput = document.getElementById("outroNameInput");
  const statusEl = document.getElementById("outroUploadStatus");
  const btn = document.getElementById("uploadOutroBtn");

  const file = fileInput?.files?.[0];
  const name = nameInput?.value.trim();

  if (!name) {
    statusEl.style.display = "block";
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Please enter a name for this outro.";
    return;
  }
  if (!file) {
    statusEl.style.display = "block";
    statusEl.style.color = "#dc2626";
    statusEl.textContent = "Please select a video file.";
    return;
  }

  btn.textContent = "Uploading...";
  btn.disabled = true;
  statusEl.style.display = "none";

  try {
    const { token } = await chrome.storage.local.get("token");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("name", name);

    const resp = await apiFetch(`${API_BASE}/outros/upload`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
      body: formData,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Upload failed");
    }

    fileInput.value = "";
    nameInput.value = "";
    statusEl.style.display = "block";
    statusEl.style.color = "#16a34a";
    statusEl.textContent = "✓ Uploaded!";
    setTimeout(() => { statusEl.style.display = "none"; }, 3000);
    await loadOutroSettings();

  } catch (err) {
    if (err.message === "session_expired") return;
    statusEl.style.display = "block";
    statusEl.style.color = "#dc2626";
    statusEl.textContent = err.message || "Upload failed. Please try again.";
  } finally {
    btn.textContent = "+ Upload Outro";
    btn.disabled = false;
  }
});

document.getElementById("outroSettingsList")?.addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest(".outro-delete-btn");
  if (!deleteBtn) return;

  const outroId = deleteBtn.dataset.id;
  deleteBtn.textContent = "Deleting...";
  deleteBtn.disabled = true;

  try {
    const { token } = await chrome.storage.local.get("token");
    const resp = await apiFetch(`${API_BASE}/outros/${outroId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok && resp.status !== 204) throw new Error("Delete failed");
    await loadOutroSettings();
  } catch (err) {
    if (err.message === "session_expired") return;
    deleteBtn.textContent = "Delete";
    deleteBtn.disabled = false;
  }
});

// Copy button handlers — work for any btn-copy button
document.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("btn-copy")) return;
  const targetId = e.target.dataset.target;
  const el = document.getElementById(targetId);
  if (!el) return;

  await navigator.clipboard.writeText(el.textContent);
  e.target.textContent = "Copied!";
  e.target.classList.add("copied");
  setTimeout(() => {
    e.target.textContent = "Copy";
    e.target.classList.remove("copied");
  }, 2000);
});


backBtn.addEventListener("click", async () => {
  // Don't remove pending_review — just go back to queue
  // User can return to review by clicking the extension icon
  chrome.action.setBadgeText({ text: "!" });  // keep badge to remind them
  showScreen(dashboardScreen);
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

fbBackBtn.addEventListener("click", () => {
  showScreen(reviewScreen);
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { token, user } = await chrome.storage.local.get(["token", "user"]);

  // Clear any stuck pending_review on startup
  await chrome.storage.local.remove("pending_review");

  if (token && user) {
    // Validate token is still accepted by the server.
    // Only logs out on 401 — network errors (offline) keep the session.
    const meResp = await fetch(`${API_BASE}/auth/me`, {
      headers: { "Authorization": `Bearer ${token}` },
    }).catch(() => null);

    if (meResp && meResp.status === 401) {
      await handleSessionExpired();
      return;
    }

    showLoggedIn(user);
    renderQueue();
    if (queueInterval) clearInterval(queueInterval);
    queueInterval = setInterval(renderQueue, 2000);
  } else {
    showScreen(loginScreen);
  }
}

function showFbListingScreen(listing, vehicle) {
  currentFbListing = { listing, vehicle };

  // Show a brief loading banner, then populate and clear it
  const loadingBanner = document.getElementById("fbLoadingBanner");
  if (loadingBanner) {
    loadingBanner.style.display = "block";
    loadingBanner.textContent = "⏳ Preparing your listing...";
  }

  showScreen(fbListingScreen);

  // Populate content on next tick so the loading state is visible briefly
  setTimeout(() => {
    const title = [vehicle.year, vehicle.make?.toUpperCase(), vehicle.model, vehicle.trim]
      .filter(Boolean).join(" ");
    fbListingTitle.textContent = title || "Vehicle Listing";
    fbListingMeta.textContent = [
      vehicle.vin ? `VIN: ${vehicle.vin}` : null,
      vehicle.price,
      vehicle.mileage,
    ].filter(Boolean).join(" · ");

    fbTitleText.textContent = listing.title;
    fbPriceText.textContent = listing.price?.replace(/[^0-9]/g, "") || "";
    fbDescText.textContent = listing.description;

    fbTagsWrap.innerHTML = (listing.tags || [])
      .map(tag => `<span class="fb-tag">#${tag}</span>`)
      .join("");

    if (loadingBanner) {
      loadingBanner.textContent = "✓ Listing ready!";
      setTimeout(() => { loadingBanner.style.display = "none"; }, 1200);
    }

    renderFbQueueStatus();
  }, 80);
}


// ── Screen management ─────────────────────────────────────────
function showScreen(screen) {
  [loginScreen, dashboardScreen, reviewScreen, fbListingScreen, settingsScreen]
    .forEach(s => { if (s) s.style.display = "none"; });
  if (screen) screen.style.display = "block";
}
function showLoggedIn(user) {
  userInfo.style.display = "flex";
  userName.textContent = user.full_name?.split(" ")[0] || user.email;
  logoutBtn.style.display = "none"; // hide old logout — using settings now
}


// ── Login ─────────────────────────────────────────────────────
loginBtn.addEventListener("click", async () => {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  loginError.textContent = "";

  if (!email || !password) {
    loginError.textContent = "Please enter your email and password.";
    return;
  }

  loginBtn.textContent = "Signing in...";
  loginBtn.disabled = true;

  try {
    // OAuth2 password flow — same as Swagger login
    const formData = new URLSearchParams();
    formData.append("username", email);
    formData.append("password", password);

    const resp = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData,
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
    if (queueInterval) clearInterval(queueInterval);
    queueInterval = setInterval(renderQueue, 2000);

  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.textContent = "Sign In";
    loginBtn.disabled = false;
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

async function updateDashboardStats(queue) {
  const today = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const completed = queue.filter(j => j.status === "completed");

  if (statAdsToday) statAdsToday.textContent =
    completed.filter(j => new Date(j.added_at).toDateString() === today).length;
  if (statAdsWeek) statAdsWeek.textContent =
    completed.filter(j => new Date(j.added_at).getTime() > weekAgo).length;
  if (statAdsTotal) statAdsTotal.textContent = completed.length;

  const { fb_posting_history = [] } = await chrome.storage.local.get("fb_posting_history");
  if (statFbPosted) statFbPosted.textContent = fb_posting_history.length;
}

async function loadRecentAds() {
  const { token, queue = [] } = await chrome.storage.local.get(["token", "queue"]);
  if (!recentAds) return;

  // Try backend first
  if (token) {
    try {
      const resp = await apiFetch(`${API_BASE}/listings/`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (resp.ok) {
        const listings = await resp.json();
        if (listings.length > 0) {
          renderListings(listings);
          return;
        }
      }
    } catch (err) {
      if (err.message !== "session_expired") console.error("OrbitAds: listings fetch failed:", err);
    }
  }

  // Fallback — show completed jobs from local queue
  const completed = queue.filter(j => j.status === "completed");
  if (completed.length === 0) {
    recentAds.innerHTML = `
      <div class="empty-hint" style="text-align:center;padding:12px;color:#9ca3af">
        Your completed ads will appear here
      </div>`;
    return;
  }

  recentAds.innerHTML = completed.reverse().map(job => {
    const v = job.vehicle;
    const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
      .filter(Boolean).join(" ");
    return `
      <div class="recent-ad-card">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title || "Unknown Vehicle"}</div>
          <div class="recent-ad-meta">${v.price || ""} · ${v.mileage || ""}</div>
          <div style="margin-top:4px">
            <span class="fb-tag" style="font-size:10px;background:#eff6ff;color:#1e40af">
              🎬 Video
            </span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          ${job.result_url
        ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ Video</a>`
        : ""}
        </div>
      </div>`;
  }).join("");

  // Update stats from local queue
  const today = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (statAdsToday) statAdsToday.textContent =
    completed.filter(j => new Date(j.added_at).toDateString() === today).length;
  if (statAdsWeek) statAdsWeek.textContent =
    completed.filter(j => new Date(j.added_at).getTime() > weekAgo).length;
  if (statAdsTotal) statAdsTotal.textContent = completed.length;
  updateSoldStat(listings);
}

function renderListings(listings) {
  if (!recentAds) return;
  recentAds.innerHTML = listings.map(l => {
    const title = [l.year, l.make, l.model, l.trim].filter(Boolean).join(" ");
    const date = new Date(l.created_at).toLocaleDateString();
    const hasVideo = !!l.video_url;
    const hasFb = l.fb_posted;
    let typeBadge = "";
    if (hasVideo && hasFb) {
      typeBadge = `<span class="fb-tag" style="font-size:10px;background:#dcfce7;color:#15803d">🎬 Video + 📘 FB</span>`;
    } else if (hasVideo) {
      typeBadge = `<span class="fb-tag" style="font-size:10px">🎬 Video</span>`;
    } else if (hasFb) {
      typeBadge = `<span class="fb-tag" style="font-size:10px;background:#dbeafe;color:#1d4ed8">📘 FB only</span>`;
    }
    return `
      <div class="recent-ad-card">
        <div class="recent-ad-info">
          <div class="recent-ad-title">${title || "Unknown Vehicle"}</div>
          <div class="recent-ad-meta">${date} · ${l.price || ""}</div>
          <div style="margin-top:4px">${typeBadge}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          ${l.is_sold ? `<span class="recent-ad-sold">🚨 Sold</span>` : ""}
          ${l.video_url
        ? `<a href="${l.video_url}" target="_blank" class="btn-small">▶ Video</a>`
        : ""}
        </div>
      </div>`;
  }).join("");

  if (statAdsTotal) statAdsTotal.textContent = listings.length;
  if (statFbPosted) statFbPosted.textContent = listings.filter(l => l.fb_posted).length;
  const today = new Date().toDateString();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (statAdsToday) statAdsToday.textContent =
    listings.filter(l => new Date(l.created_at).toDateString() === today).length;
  if (statAdsWeek) statAdsWeek.textContent =
    listings.filter(l => new Date(l.created_at).getTime() > weekAgo).length;
}

let recentAdsLoadCount = 0;

// ── Queue rendering ───────────────────────────────────────────
async function renderQueue() {
  if (reviewScreen?.style.display !== "none") return;
  if (fbListingScreen?.style.display !== "none") return;
  if (settingsScreen?.style.display !== "none") return;
  if (generateModal?.style.display !== "none") return;

  // Pick up session_expired flag set by background.js
  const { session_expired } = await chrome.storage.local.get("session_expired");
  if (session_expired) {
    await chrome.storage.local.remove("session_expired");
    await handleSessionExpired();
    return;
  }

  const { queue = [], pending_review_queue = [] } =
    await chrome.storage.local.get(["queue", "pending_review_queue"]);

  showScreen(dashboardScreen);

  // ── Stale banner ──────────────────────────────────────────
  const { stale_review_notice } = await chrome.storage.local.get("stale_review_notice");
  const staleBanner = document.getElementById("staleBanner");
  if (stale_review_notice && staleBanner) {
    staleBanner.style.display = "flex";
    staleBanner.innerHTML = `
      <span>ℹ️ ${stale_review_notice}</span>
      <button class="btn-small" id="dismissStaleBtn">OK</button>`;
    document.getElementById("dismissStaleBtn")?.addEventListener("click", async () => {
      await chrome.storage.local.remove("stale_review_notice");
      staleBanner.style.display = "none";
    });
  } else if (staleBanner) {
    staleBanner.style.display = "none";
  }

  // ── Sold banner ───────────────────────────────────────────
  const { sold_notifications = [] } = await chrome.storage.local.get("sold_notifications");
  const soldBanner = document.getElementById("soldBanner");
  if (sold_notifications.length > 0 && soldBanner) {
    soldBanner.style.display = "flex";
    soldBanner.innerHTML = `
      <span>🚨 ${sold_notifications.length} vehicle${sold_notifications.length > 1 ? 's' : ''} may be sold</span>
      <button class="btn-small" id="dismissSoldBtn">Dismiss</button>`;
    document.getElementById("dismissSoldBtn")?.addEventListener("click", async () => {
      await chrome.storage.local.remove("sold_notifications");
      chrome.action.setBadgeText({ text: "" });
      soldBanner.style.display = "none";
    });
  } else if (soldBanner) {
    soldBanner.style.display = "none";
  }

  // ── Build unified card list ───────────────────────────────
  const allCards = [
    ...[...pending_review_queue].reverse().map(item => ({
      type: "review",
      item: item,
      vehicle: item.vehicle,
      status: item.classified ? "ready" : "classifying",
    })),
    ...[...queue].reverse().map(job => ({
      type: "job",
      item: job,
      vehicle: job.vehicle,
      status: job.status,
    })),
  ];

  if (allCards.length === 0) {
    if (queueEmpty) queueEmpty.style.display = "block";
    jobList.innerHTML = "";
  } else {
    if (queueEmpty) queueEmpty.style.display = "none";
    jobList.innerHTML = allCards.map(card => renderUnifiedCard(card)).join("");
    attachCardHandlers();
  }

  // ── Stats ─────────────────────────────────────────────────
  updateDashboardStats(queue);
  recentAdsLoadCount++;
  if (recentAdsLoadCount === 1 || recentAdsLoadCount % 10 === 0) {
    loadRecentAds();
  }
}

function renderUnifiedCard(card) {
  const v = card.vehicle;
  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  const meta = [v.mileage, v.vin ? `VIN: ${v.vin}` : null]
    .filter(Boolean).join(" · ");

  let badgeClass = "badge-waiting";
  let badgeText = "Waiting";
  let cardClass = "job-card";
  let actionBtn = "";
  let progressBar = "";

  if (card.type === "review") {
    if (card.status === "classifying") {
      badgeClass = "badge-classifying";
      badgeText = "🔍 Classifying";
      cardClass = "job-card job-card-classifying";
      actionBtn = `<button class="btn-generate classifying" disabled>
                     🔍 Classifying photos...
                   </button>`;
    } else {
      // Ready to generate
      badgeClass = "badge-waiting";
      badgeText = "Ready";
      cardClass = "job-card job-card-ready";
      actionBtn = `<button class="btn-generate generate-btn"
                            data-type="review"
                            data-vin="${v.vin || ""}"
                            data-model="${v.model || ""}"
                            data-queue-item-id="${card.item.queue_item_id || ""}">
                     Generate Ad →
                   </button>`;
    }
  } else {
    // Generation job
    const job = card.item;
    if (job.status === "waiting" || job.status === "generating") {
      badgeClass = "badge-generating";
      badgeText = job.status === "generating" ? "Generating" : "Waiting";
      cardClass = "job-card job-card-generating";
      progressBar = `<div class="progress-wrap">
                       <div class="progress-bar" style="width:${job.progress || 0}%"></div>
                     </div>
                     <div class="job-label">${job.label || ""}</div>`;
    } else if (job.status === "completed") {
      badgeClass = "badge-done";
      badgeText = "Done ✓";
      cardClass = "job-card job-card-done";
      progressBar = `<div class="progress-wrap">
                       <div class="progress-bar done" style="width:100%"></div>
                     </div>`;
      actionBtn = `<div class="job-actions">
                     ${job.result_url
          ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ View Ad</a>`
          : ""}
                     <button class="btn-small post-fb-from-queue"
                             data-job-id="${job.id}"
                             style="background:#1877f2">📘 Post to FB</button>
                   </div>`;
    } else if (job.status === "failed") {
      badgeClass = "badge-failed";
      badgeText = "Failed";
      cardClass = "job-card job-card-failed";
      actionBtn = `<div class="job-label" style="color:#dc2626;font-size:11px;margin-top:4px">
                     ${getFriendlyError(job.error)}
                   </div>
                   <button class="btn-small remove-failed-btn"
                           data-job-id="${job.id}"
                           style="margin-top:6px;background:#6b7280">Remove</button>`;
    }
  }

  return `
    <div class="${cardClass}"
         data-vin="${v.vin || ""}"
         data-model="${v.model || ""}"
         data-type="${card.type}"
         data-job-id="${card.type === 'job' ? card.item.id : ''}"
         data-queue-item-id="${card.type === 'review' ? (card.item.queue_item_id || '') : ''}">
      <div class="job-top">
        <div class="job-title">${title || "Unknown Vehicle"}</div>
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="clear-card-btn" title="Remove">×</button>
      </div>
      ${meta ? `<div class="job-meta">${meta}</div>` : ""}
      ${v.price ? `<div class="job-price">${v.price}</div>` : ""}
      ${progressBar}
      ${actionBtn}
    </div>`;
}

function attachCardHandlers(allCards) {

  // Post to FB from completed job
  document.querySelectorAll(".post-fb-from-queue").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();

      // Immediate feedback — before any awaits
      const originalText = btn.textContent;
      btn.textContent = "⏳ Preparing listing...";
      btn.disabled = true;
      btn.style.opacity = "0.7";

      const jobId = btn.dataset.jobId;
      const { queue = [], token } = await chrome.storage.local.get(["queue", "token"]);
      const job = queue.find(j => j.id === jobId);
      if (!job) {
        btn.textContent = originalText;
        btn.disabled = false;
        btn.style.opacity = "1";
        return;
      }

      try {
        btn.textContent = "⏳ Generating listing...";
        const v = job.vehicle;
        const resp = await apiFetch(`${API_BASE}/listings/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            year: v.year, make: v.make, model: v.model, trim: v.trim,
            price: v.price, mileage: v.mileage, vin: v.vin, listing_url: v.listing_url,
          }),
        });
        if (!resp.ok) throw new Error("Failed to generate listing");
        const listing = await resp.json();

        btn.textContent = "⏳ Opening Facebook...";
        await chrome.storage.local.set({
          fb_listing: {
            ...listing,
            vehicle: v,
            reviewed_photos: v.photos_for_video || [],
            video_url: job.result_url || null,
            created_at: new Date().toISOString(),
          }
        });

        showFbListingScreen(listing, v);
        chrome.runtime.sendMessage({
          type: "MARK_LISTING_POSTED",
          vehicle: v,
          listing_url: v.listing_url,
        });
      } catch (err) {
        btn.textContent = originalText;
        btn.disabled = false;
        btn.style.opacity = "1";
      }
    });
  });

  // Remove failed job
  document.querySelectorAll(".remove-failed-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const jobId = btn.dataset.jobId;
      const { queue = [] } = await chrome.storage.local.get("queue");
      await chrome.storage.local.set({
        queue: queue.filter(j => j.id !== jobId)
      });
      renderQueue();
    });
  });

  // Click card to edit photos
  document.querySelectorAll(".job-card[data-type='review']").forEach(card => {
    card.addEventListener("click", async (e) => {
      if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return;

      const vin = card.dataset.vin;
      const queueItemId = card.dataset.queueItemId;

      const { pending_review_queue = [] } =
        await chrome.storage.local.get("pending_review_queue");

      const item = pending_review_queue.find(i =>
        (queueItemId && i.queue_item_id === queueItemId) ||
        (vin && i.vehicle.vin === vin)
      );

      if (item) showReviewScreen(item);
    });
  });
}

async function showGenerateModal(vehicle) {
  modalVehicle = vehicle;
  const title = [vehicle.year, vehicle.make?.toUpperCase(), vehicle.model]
    .filter(Boolean).join(" ");
  modalVehicleTitle.textContent = title;

  // Reset to step 1 — note: modalQueueItemId is set by the caller before showGenerateModal
  modalSelectedOutroId = null;
  [modalStep1, modalStep2, modalStep3, modalStep4, modalStepOutro]
    .forEach(s => s.style.display = "none");
  modalStep1.style.display = "block";
  generateModal.style.display = "flex";

  // Disable video options when no voice ID is saved
  const { user } = await chrome.storage.local.get("user");
  const hasVoice = !!user?.elevenlabs_voice_id;

  document.querySelectorAll('.modal-option[data-type="slideshow"], .modal-option[data-type="with_outro"]')
    .forEach(btn => {
      btn.disabled = !hasVoice;
      btn.classList.toggle("modal-option-disabled", !hasVoice);
    });

  const hint = document.getElementById("modalVoiceHint");
  if (hint) hint.style.display = hasVoice ? "none" : "block";
}

closeModal?.addEventListener("click", () => {
  generateModal.style.display = "none";
});

// Step 1 — choose type
document.querySelectorAll(".modal-option").forEach(btn => {
  btn.addEventListener("click", () => {
    modalSelectedType = btn.dataset.type;

    if (modalSelectedType === "photos") {
      generateModal.style.display = "none";
      generateAdWithOptions("photos", "family", null);
    } else if (modalSelectedType === "with_outro") {
      modalStep1.style.display = "none";
      modalStepOutro.style.display = "block";
      loadOutroStep();
    } else {
      // slideshow — go straight to theme selection
      modalStep1.style.display = "none";
      modalStep2.style.display = "block";
    }
  });
});

// Step 2 — choose theme
document.querySelectorAll(".theme-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    modalSelectedTheme = btn.dataset.theme;
    document.querySelectorAll(".theme-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");

    if (modalSelectedTheme === "custom") {
      modalStep2.style.display = "none";
      modalStep3.style.display = "block";
    } else {
      generateModal.style.display = "none";
      generateAdWithOptions(modalSelectedType, modalSelectedTheme, null);
    }
  });
});

// Back buttons
document.getElementById("backToStep1")?.addEventListener("click", () => {
  modalStep2.style.display = "none";
  modalStep1.style.display = "block";
});

document.getElementById("backFromOutroStep")?.addEventListener("click", () => {
  modalStepOutro.style.display = "none";
  modalStep1.style.display = "block";
});

document.getElementById("outroConfirmBtn")?.addEventListener("click", () => {
  modalStepOutro.style.display = "none";
  modalStep2.style.display = "block";
});

async function loadOutroStep() {
  const list = document.getElementById("outroSelectList");
  const confirmBtn = document.getElementById("outroConfirmBtn");
  modalSelectedOutroId = null;
  confirmBtn.style.display = "none";
  list.innerHTML = `<p style="color:#6b7280;font-size:13px;text-align:center;padding:12px">Loading...</p>`;

  const { token } = await chrome.storage.local.get("token");
  try {
    const resp = await apiFetch(`${API_BASE}/outros/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error("Failed to load outros");
    const outros = await resp.json();

    if (outros.length === 0) {
      list.innerHTML = `
        <div style="text-align:center;padding:16px">
          <p style="color:#6b7280;font-size:13px;margin-bottom:10px">
            No outro videos saved yet.
          </p>
          <button class="btn-secondary" id="outroGoToSettings">Add one in Settings →</button>
        </div>`;
      document.getElementById("outroGoToSettings")?.addEventListener("click", () => {
        generateModal.style.display = "none";
        showSettingsScreen();
      });
      return;
    }

    list.innerHTML = outros.map(o => `
      <div class="outro-option" data-id="${o.id}">
        <span class="outro-option-name">${o.name}</span>
        <span class="outro-check">✓</span>
      </div>`).join("");

    list.querySelectorAll(".outro-option").forEach(el => {
      el.addEventListener("click", () => {
        list.querySelectorAll(".outro-option").forEach(e => e.classList.remove("selected"));
        el.classList.add("selected");
        modalSelectedOutroId = parseInt(el.dataset.id);
        confirmBtn.style.display = "block";
      });
    });

  } catch (err) {
    if (err.message === "session_expired") return;
    list.innerHTML = `<p style="color:#dc2626;font-size:13px;text-align:center">Failed to load. Please try again.</p>`;
  }
}

document.getElementById("backToStep2")?.addEventListener("click", () => {
  modalStep3.style.display = "none";
  modalStep2.style.display = "block";
});

document.getElementById("backToStep3")?.addEventListener("click", () => {
  modalStep4.style.display = "none";
  modalStep3.style.display = "block";
});

// Step 3 — preview custom script
document.getElementById("previewScriptBtn")?.addEventListener("click", async () => {
  const prompt = document.getElementById("customPrompt")?.value.trim();
  if (!prompt) return;

  const btn = document.getElementById("previewScriptBtn");
  btn.textContent = "Generating script...";
  btn.disabled = true;

  try {
    const { token } = await chrome.storage.local.get("token");
    const v = modalVehicle;
    const vehicleInfo = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");

    const resp = await apiFetch(`${API_BASE}/listings/generate-script`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({
        vehicle_info: vehicleInfo,
        custom_prompt: prompt,
      }),
    });

    if (!resp.ok) throw new Error("Failed");
    const data = await resp.json();

    document.getElementById("scriptPreview").value = data.script;
    modalStep3.style.display = "none";
    modalStep4.style.display = "block";
  } catch (err) {
    alert("Failed to generate script. Please try again.");
  } finally {
    btn.textContent = "Preview Script →";
    btn.disabled = false;
  }
});

// Step 4 — confirm and generate
document.getElementById("confirmGenerateBtn")?.addEventListener("click", () => {
  const script = document.getElementById("scriptPreview")?.value;
  generateModal.style.display = "none";
  generateAdWithOptions(modalSelectedType, "custom", script);
});

async function generateAdWithOptions(videoType, theme, customScript) {
  // Capture all globals immediately — they can be overwritten if the user
  // clicks another card before this async function finishes awaiting.
  const capturedVehicle = reviewVehicle;
  const capturedPhotos = reviewPhotos;
  const capturedQueueItemId = modalQueueItemId;
  const capturedOutroId = modalSelectedOutroId;

  if (!capturedVehicle) return;

  const allPhotos = [
    ...(capturedPhotos.exterior || []),
    ...(capturedPhotos.interior || []),
    ...(capturedPhotos.additional || []),
  ];

  if (allPhotos.length === 0) {
    alert("No photos selected. Please click the vehicle card to review photos first.");
    return;
  }

  const vehicle = { ...capturedVehicle, photos_for_video: allPhotos };

  await chrome.runtime.sendMessage({
    type: "QUEUE_REVIEWED",
    vehicle: vehicle,
    video_type: videoType === "photos" ? "slideshow" : videoType,
    theme: theme,
    custom_script: customScript || null,
    outro_video_id: videoType === "with_outro" ? capturedOutroId : null,
    photos_only: videoType === "photos",
  });

  // Remove this specific car from the pending review queue.
  // Use queue_item_id (exact) so same-model cars don't remove each other.
  const { pending_review_queue: rawQueue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const updatedQueue = rawQueue.filter(item =>
    capturedQueueItemId
      ? item.queue_item_id !== capturedQueueItemId
      : capturedVehicle.vin
        ? item.vehicle?.vin !== capturedVehicle.vin
        : !(item.vehicle?.model === capturedVehicle.model && item.vehicle?.year === capturedVehicle.year)
  );

  await chrome.storage.local.set({ pending_review_queue: updatedQueue });
  chrome.action.setBadgeText({ text: updatedQueue.length > 0 ? String(updatedQueue.length) : "" });

  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
}

document.getElementById("toggleRecentBtn")?.addEventListener("click", () => {
  const btn = document.getElementById("toggleRecentBtn");
  const panel = document.getElementById("recentAds");
  if (panel.style.display === "none") {
    panel.style.display = "block";
    btn.textContent = "Hide";
    loadRecentAds();
  } else {
    panel.style.display = "none";
    btn.textContent = "Show";
  }
});



function getFriendlyError(error) {
  if (!error) return "Something went wrong. Please try again.";
  if (error.includes("Shotstack") && error.includes("credits"))
    return "⚠️ Video generation limit reached. Please contact support or upgrade your plan.";
  if (error.includes("401") || error.includes("Unauthorized"))
    return "⚠️ Session expired. Please sign out and sign back in.";
  if (error.includes("NHTSA") || error.includes("VIN"))
    return "⚠️ Could not decode VIN. The video may still generate with limited info.";
  if (error.includes("ElevenLabs"))
    return "⚠️ Voice generation failed. Check your ElevenLabs voice ID in Settings.";
  if (error.includes("HeyGen"))
    return "⚠️ Avatar generation failed. Check your HeyGen avatar ID in Settings.";
  if (error.includes("timeout") || error.includes("timed out"))
    return "⚠️ Generation timed out. Please try again.";
  return "⚠️ Generation failed. Please try again or contact support.";
}

function renderJobCard(job) {
  const v = job.vehicle;
  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  const meta = [v.mileage, v.vin ? `VIN: ${v.vin}` : null]
    .filter(Boolean).join(" · ");

  let badgeClass = "badge-waiting";
  let badgeText = "Waiting";
  if (job.status === "generating") { badgeClass = "badge-generating"; badgeText = "Generating"; }
  if (job.status === "completed") { badgeClass = "badge-done"; badgeText = "Done ✓"; }
  if (job.status === "failed") { badgeClass = "badge-failed"; badgeText = "Failed"; }

  const progressBarClass = job.status === "completed" ? "done" :
    job.status === "failed" ? "failed" : "";

  const actionsHtml = job.status === "completed"
    ? `<div class="job-actions" style="display:flex;gap:6px;margin-top:6px">
       ${job.result_url
      ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ View Ad</a>`
      : `<span class="job-label" style="color:#6b7280">Fetching video...</span>`
    }
       <button class="btn-small post-fb-from-queue" 
               data-job-id="${job.id}"
               style="background:#1877f2">
         📘 Post to FB
       </button>
     </div>`
    : job.status === "failed" && job.error
      ? `<div class="job-label" style="color:#dc2626;margin-top:4px">
       ${getFriendlyError(job.error)}
     </div>
     <button class="btn-small retry-btn" data-job-id="${job.id}"
             style="margin-top:6px;background:#6b7280">
       Remove
     </button>`
      : "";

  return `
    <div class="job-card" data-job-id="${job.id}" style="cursor:pointer">
      <div class="job-top">
        <div class="job-title job-title-link">${title || "Unknown Vehicle"}</div>
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

// ── Review screen ─────────────────────────────────────────────

// Track user's selected photos for video

async function checkPendingReview() {
  const { pending_review } = await chrome.storage.local.get("pending_review");
  if (!pending_review) return false;

  // Check if review is stale (older than 2 hours and still unclassified)
  const age = Date.now() - new Date(pending_review.added_at).getTime();
  const isStale = age > 2 * 60 * 60 * 1000 && !pending_review.classified;

  if (isStale) {
    // Show a warning notification in the dashboard
    await chrome.storage.local.set({
      stale_review_notice: `Some vehicles from your previous session need to be re-imported. Please import them again from your inventory.`
    });
    await chrome.storage.local.remove("pending_review");
    chrome.action.setBadgeText({ text: "" });
    return false;
  }

  showReviewScreen(pending_review);
  return true;
}

function buildReviewPhotos(classified, photosAll, blockedPhotos = [], explicitOther = []) {
  const explicitOtherSet = new Set(explicitOther);
  const photos = {
    exterior: classified.exterior || [],
    interior: classified.interior || [],
    additional: classified.additional || [],
    other: classified.other || [],
  };

  // Merge all unclassified photos from photos_all into other
  const allClassifiedUrls = new Set([
    ...photos.exterior,
    ...photos.interior,
    ...photos.additional,
    ...photos.other,
  ]);
  const unclassified = (photosAll || [])
    .filter(url => !allClassifiedUrls.has(url));
  photos.other = [...photos.other, ...unclassified];

  // Deduplicate across all sections
  const seenUrls = new Set();
  ['exterior', 'interior', 'additional', 'other'].forEach(section => {
    photos[section] = (photos[section] || []).filter(url => {
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });
  });

  // Auto-fill additional from other to reach 20 total
  // Only after dedup and merge so logos are already in other
  const currentTotal = photos.exterior.length +
    photos.interior.length +
    photos.additional.length;
  const needed = Math.max(0, 20 - currentTotal);

  if (needed > 0) {
    const candidates = photos.other.filter(url => {
      const filename = url.split('/').pop().toLowerCase();
      const lower = url.toLowerCase();
      // Never auto-fill photos Claude explicitly said are "other"
      if (explicitOtherSet.has(url)) return false;
      if (filename.endsWith('.png')) return false;
      const junkPatterns = ['showme', 'carfax', 'valuebadge', 'videoplayer'];
      if (junkPatterns.some(p => lower.includes(p))) return false;
      return true;
    });

    const toAdd = candidates.slice(0, needed);
    photos.additional = [...photos.additional, ...toAdd];
    const addedSet = new Set(toAdd);
    photos.other = photos.other.filter(u => !addedSet.has(u));
  }

  return photos;
}

let activeJobInterval = null;

async function pollActiveJob() {
  if (activeJobPolling) return;
  activeJobPolling = true;

  // Clear any existing interval
  if (activeJobInterval) {
    clearInterval(activeJobInterval);
    activeJobInterval = null;
  }

  activeJobInterval = setInterval(async () => {
    // Declare FIRST before any usage
    const { queue = [], current_generating_vin } =
      await chrome.storage.local.get(["queue", "current_generating_vin"]);

    const currentLatestJob = current_generating_vin
      ? queue.find(j => j.vehicle?.vin === current_generating_vin) || queue[queue.length - 1]
      : queue[queue.length - 1];

    // Now safe to use
    if (!currentLatestJob) return;

    const statusEl = document.getElementById("activeJobStatus");
    const labelEl = document.getElementById("activeJobLabel");
    const barEl = document.getElementById("activeJobBar");

    if (!statusEl) return;

    statusEl.style.display = "block";
    labelEl.textContent = currentLatestJob.label || "Processing...";
    barEl.style.width = (currentLatestJob.progress || 0) + "%";

    if (currentLatestJob.status === "completed") {
      clearInterval(activeJobInterval);
      activeJobInterval = null;
      activeJobPolling = false;

      const completedRecently = currentLatestJob.added_at &&
        (Date.now() - new Date(currentLatestJob.added_at).getTime()) < 3600000;

      statusEl.querySelectorAll("a").forEach(el => el.remove());

      if (currentLatestJob.result_url && completedRecently) {
        labelEl.textContent = "✓ Ad ready!";
        barEl.classList.add("done");
        const viewBtn = document.createElement("a");
        viewBtn.href = currentLatestJob.result_url;
        viewBtn.target = "_blank";
        viewBtn.className = "btn-small injected-view-btn";
        viewBtn.textContent = "▶ View Ad";
        viewBtn.style.marginTop = "8px";
        viewBtn.style.display = "inline-block";
        statusEl.appendChild(viewBtn);
      } else {
        statusEl.style.display = "none";
      }
      return;
    }

    if (currentLatestJob.status === "failed") {
      clearInterval(activeJobInterval);
      activeJobInterval = null;
      activeJobPolling = false;
      labelEl.textContent = `Failed: ${currentLatestJob.error || "Unknown error"}`;
      labelEl.style.color = "#dc2626";
      barEl.classList.add("failed");
      return;
    }

    // Still running — check if we left the review screen
    if (reviewScreen.style.display === "none") {
      clearInterval(activeJobInterval);
      activeJobInterval = null;
      activeJobPolling = false;
    }

  }, 3000);
}


function showReviewScreen(pendingReview) {
  // Kill any running poll interval
  if (activeJobInterval) {
    clearInterval(activeJobInterval);
    activeJobInterval = null;
  }
  activeJobPolling = false;
  // Reset state completely
  reviewPhotos = { exterior: [], interior: [], additional: [], other: [] };
  reviewVehicle = null;
  activeJobPolling = false;  // reset polling flag

  // Clear Ad ready banner
  const statusEl = document.getElementById("activeJobStatus");
  if (statusEl) {
    statusEl.style.display = "none";
    statusEl.querySelectorAll("a").forEach(el => el.remove());
  }
  const labelEl = document.getElementById("activeJobLabel");
  if (labelEl) labelEl.textContent = "";
  const barEl = document.getElementById("activeJobBar");
  if (barEl) {
    barEl.style.width = "0%";
    barEl.classList.remove("done", "failed");
  }

  // ... rest of function unchanged

  // Clean up injected buttons
  document.querySelectorAll(".btn-primary[href], .injected-view-btn").forEach(el => el.remove());
  if (generateBtn?.id) generateBtn.style.display = "block";

  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
  }
  const v = pendingReview.vehicle;
  reviewVehicle = v;

  const title = [v.year, v.make?.toUpperCase(), v.model, v.trim]
    .filter(Boolean).join(" ");
  reviewTitle.textContent = title || "Unknown Vehicle";
  reviewMeta.textContent = [
    v.vin ? `VIN: ${v.vin}` : null,
    v.price ? v.price : null,
    v.mileage ? v.mileage : null,
  ].filter(Boolean).join(" · ");

  if (pendingReview.classified) {
    reviewStatus.style.display = "none";

    if (pendingReview.review_photos) {
      // Restore user's saved edits
      reviewPhotos = pendingReview.review_photos;
    } else {
      // Build fresh from classification
      reviewPhotos = buildReviewPhotos(
        pendingReview.classified,
        pendingReview.photos_all || pendingReview.vehicle.photos,
        pendingReview.blocked_photos || [],
        pendingReview.explicit_other || []
      );
    }

    renderPhotoSections();
    if (generateBtn?.id) generateBtn.disabled = false;
    if (facebookBtn?.id) facebookBtn.disabled = false;
    if (generateBtn?.id) generateBtn.textContent = "Generate Ad →";
  }
  else {
    reviewStatus.textContent = "🔍 Classifying photos...";
    reviewStatus.style.display = "block";
    if (generateBtn?.id) generateBtn.disabled = true;
    if (generateBtn?.id) generateBtn.textContent = "Classifying...";
    // Poll until classification is done
    pollClassification();
  }

  showScreen(reviewScreen);

  if (pendingReview.view_only && pendingReview.review_photos) {
    // Populate reviewPhotos so facebookBtn can use it
    reviewPhotos = pendingReview.review_photos;
  }

  if (pendingReview.view_only && pendingReview.completed_job?.result_url) {
    // Don't try to manipulate generateBtn DOM — just skip
  } else {
    document.querySelectorAll(".btn-primary[href]").forEach(el => el.remove());
  }
  pollActiveJob();
  // Queue preview mode — promote to active pending on generate
  if (pendingReview.queue_preview) {
    if (generateBtn?.id) generateBtn.textContent = "Start Review →";
    if (generateBtn?.id) generateBtn.disabled = false;

    // Override generate button to promote this car
    const newGenerateBtn = generateBtn.cloneNode(true);
    generateBtn.parentNode.replaceChild(newGenerateBtn, generateBtn);
    newGenerateBtn.addEventListener("click", async () => {
      const { pending_review_queue = [], pending_review } =
        await chrome.storage.local.get(["pending_review_queue", "pending_review"]);

      // Remove selected from queue
      const newQueue = [...pending_review_queue];
      newQueue.splice(pendingReview.queue_index, 1);

      // If there's a current pending_review, put it back at front
      if (pending_review && !pending_review.view_only) {
        newQueue.unshift(pending_review);
      }

      await chrome.storage.local.set({
        pending_review: { ...pendingReview, queue_preview: false },
        pending_review_queue: newQueue,
      });

      // Re-run classification for this vehicle
      chrome.runtime.sendMessage({
        type: "CLASSIFY_PENDING",
        vehicle: pendingReview.vehicle,
      });

      // Reload the review screen as active
      showReviewScreen({ ...pendingReview, queue_preview: false });
    });
  }
}

async function pollClassification() {
  const startTime = Date.now();
  const TIMEOUT_MS = 3 * 60 * 1000;

  // Store the vehicle we're currently reviewing
  const vehicleVin = reviewVehicle?.vin;
  const vehicleModel = reviewVehicle?.model;

  const interval = setInterval(async () => {
    if (Date.now() - startTime > TIMEOUT_MS) {
      clearInterval(interval);
      // ... existing timeout handling unchanged
      return;
    }

    // Check pending_review for classification result
    const { pending_review, pending_review_queue = [] } =
      await chrome.storage.local.get(["pending_review", "pending_review_queue"]);

    // Find classification result — check both pending_review and queue
    let classified = null;
    let explicitOther = [];
    let blockedPhotos = [];
    let photosAll = [];

    if (pending_review?.classified && (
      pending_review.vehicle?.vin === vehicleVin ||
      pending_review.vehicle?.model === vehicleModel
    )) {
      classified = pending_review.classified;
      explicitOther = pending_review.explicit_other || [];
      blockedPhotos = pending_review.blocked_photos || [];
      photosAll = pending_review.photos_all || reviewVehicle?.photos || [];
    } else {
      // Check queue items
      const queueItem = pending_review_queue.find(item =>
        (vehicleVin && item.vehicle?.vin === vehicleVin) ||
        item.vehicle?.model === vehicleModel
      );
      if (queueItem?.classified) {
        classified = queueItem.classified;
        explicitOther = queueItem.explicit_other || [];
        blockedPhotos = queueItem.blocked_photos || [];
        photosAll = queueItem.photos_all || reviewVehicle?.photos || [];
      }
    }

    if (classified) {
      clearInterval(interval);
      reviewStatus.style.display = "none";

      reviewPhotos = buildReviewPhotos(
        classified,
        photosAll,
        blockedPhotos,
        explicitOther,
      );

      await saveReviewPhotos();
      renderPhotoSections();
      updateFbBar();
      if (generateBtn?.id) generateBtn.disabled = false;
      if (generateBtn?.id) generateBtn.textContent = "Generate Ad →";
      if (facebookBtn?.id) facebookBtn.disabled = false;
    }
  }, 2000);
}

function startFbCountdown() {
  const banner = document.getElementById("fbCountdownBanner");
  const timerEl = document.getElementById("fbCountdownTimer");
  if (!banner || !timerEl) return;

  async function updateCountdown() {
    const { fb_posting_history = [], fb_post_queue = [] } =
      await chrome.storage.local.get(["fb_posting_history", "fb_post_queue"]);

    // Find the most recent post time
    const lastPostTime = fb_posting_history
      .map(h => new Date(h.timestamp).getTime())
      .sort((a, b) => b - a)[0];

    // Find next queued item's post_after time
    const nextQueuedItem = fb_post_queue
      .filter(j => j.status === "waiting")
      .sort((a, b) => new Date(a.post_after) - new Date(b.post_after))[0];

    if (!lastPostTime && !nextQueuedItem) {
      banner.style.display = "none";
      return;
    }

    // Calculate next safe post time
    const minGap = 7 * 60 * 1000;  // 7 minutes
    const nextSafe = nextQueuedItem
      ? new Date(nextQueuedItem.post_after).getTime()
      : (lastPostTime + minGap);

    const now = Date.now();
    const remaining = nextSafe - now;

    if (remaining <= 0) {
      // Ready to post
      banner.style.display = "flex";
      banner.style.background = "#dcfce7";
      banner.style.borderColor = "#86efac";
      banner.style.color = "#15803d";
      timerEl.textContent = "Ready to post! ✓";
      timerEl.style.color = "#15803d";
      return;
    }

    // Show countdown
    banner.style.display = "flex";
    banner.style.background = "#eff6ff";
    banner.style.borderColor = "#bfdbfe";
    banner.style.color = "#1e40af";
    timerEl.style.color = "#1a56db";

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  // Update immediately then every second
  updateCountdown();
  setInterval(updateCountdown, 1000);
}

function updateFbBar() {
  const total = (reviewPhotos.exterior || []).length +
    (reviewPhotos.interior || []).length +
    (reviewPhotos.additional || []).length;
  // Note: "other/unclassified" intentionally excluded from FB count
  // since those are logos and junk the user needs to manually move or delete
  const pct = Math.min((total / 20) * 100, 100);
  const fill = document.getElementById("fbBarFill");
  const count = document.getElementById("fbCount");
  if (!fill || !count) return;
  fill.style.width = pct + "%";
  fill.classList.toggle("over", total > 20);
  count.textContent = `${total} / 20`;
  count.style.color = total > 20 ? "#dc2626" : "#374151";
}

async function saveReviewPhotos() {
  const { pending_review_queue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const idx = pending_review_queue.findIndex(item =>
    (reviewVehicle?.vin && item.vehicle?.vin === reviewVehicle.vin) ||
    item.vehicle?.model === reviewVehicle?.model
  );

  if (idx >= 0) {
    pending_review_queue[idx].review_photos = reviewPhotos;
    await chrome.storage.local.set({ pending_review_queue });
  }

  // Also save to pending_review for backward compatibility
  const { pending_review } = await chrome.storage.local.get("pending_review");
  if (pending_review) {
    pending_review.review_photos = reviewPhotos;
    await chrome.storage.local.set({ pending_review });
  }
}

function renderPhotoSections() {
  // Initialize additional if not exists

  if (!reviewPhotos.additional) reviewPhotos.additional = [];

  const sections = [
    { key: "exterior", label: "Exterior" },
    { key: "interior", label: "Interior" },
    { key: "additional", label: "Additional" },
    { key: "other", label: "Unclassified" },
  ];

  reviewSections.innerHTML = sections
    .filter(s => reviewPhotos[s.key] !== undefined)
    .map(s => `
    <div class="review-section">
      <div class="review-section-title">
        ${s.label} (${(reviewPhotos[s.key] || []).length})
      </div>
      <div class="photo-grid" data-section="${s.key}">
        ${(reviewPhotos[s.key] || []).map((url, i) => `
          <div class="photo-thumb" draggable="true"
               data-url="${url}" data-section="${s.key}" data-index="${i}">
            <img src="${url}" alt="" loading="lazy">
            <button class="remove-btn" 
                    data-url="${url}" 
                    data-section="${s.key}">×</button>
          </div>
        `).join("")}
        <div class="drop-zone" data-section="${s.key}">
          Drop here
        </div>
      </div>
    </div>
  `).join("");

  // Remove button handlers
  reviewSections.querySelectorAll(".remove-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      const section = btn.dataset.section;
      reviewPhotos[section] = reviewPhotos[section].filter(u => u !== url);
      renderPhotoSections();
      updateFbBar();
      saveReviewPhotos();
    });
  });

  updateFbBar();
  initDragAndDrop();
}

function initDragAndDrop() {
  let dragSrc = null;

  // Drag start/end on thumbnails
  document.querySelectorAll(".photo-thumb").forEach(thumb => {
    thumb.addEventListener("dragstart", (e) => {
      dragSrc = thumb;
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => thumb.style.opacity = "0.4", 0);
    });

    thumb.addEventListener("dragend", () => {
      thumb.style.opacity = "1";
      dragSrc = null;
      document.querySelectorAll(".drop-zone, .photo-thumb").forEach(el => {
        el.classList.remove("drag-over", "drag-over-grid");
      });
    });

    thumb.addEventListener("dragover", (e) => {
      e.preventDefault();
      thumb.classList.add("drag-over");
    });

    thumb.addEventListener("dragleave", () => {
      thumb.classList.remove("drag-over");
    });

    thumb.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.classList.remove("drag-over");
      if (!dragSrc || dragSrc === thumb) return;

      const srcUrl = dragSrc.dataset.url;
      const srcSection = dragSrc.dataset.section;
      const dstSection = thumb.dataset.section;
      const dstUrl = thumb.dataset.url;

      reviewPhotos[srcSection] = reviewPhotos[srcSection].filter(u => u !== srcUrl);
      const dstIndex = reviewPhotos[dstSection].indexOf(dstUrl);
      if (dstIndex >= 0) {
        reviewPhotos[dstSection].splice(dstIndex, 0, srcUrl);
      } else {
        reviewPhotos[dstSection].push(srcUrl);
      }

      renderPhotoSections();
      updateFbBar();
      saveReviewPhotos();
    });
  });

  // Drop zones — one per section, always visible at bottom of grid
  document.querySelectorAll(".drop-zone").forEach(zone => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over-grid");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("drag-over-grid");
    });

    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("drag-over-grid");
      if (!dragSrc) return;

      const srcUrl = dragSrc.dataset.url;
      const srcSection = dragSrc.dataset.section;
      const dstSection = zone.dataset.section;

      if (srcSection === dstSection) return;

      reviewPhotos[srcSection] = reviewPhotos[srcSection].filter(u => u !== srcUrl);
      reviewPhotos[dstSection].push(srcUrl);

      renderPhotoSections();
      updateFbBar();
      saveReviewPhotos();
    });
  });
}

generateBtn.addEventListener("click", async () => {
  generateBtn.disabled = true;
  generateBtn.textContent = "Adding to queue...";
  generateBtn.style.background = "#6b7280";

  const allPhotos = [
    ...reviewPhotos.exterior,
    ...reviewPhotos.interior,
    ...(reviewPhotos.additional || []),
  ];

  if (allPhotos.length === 0) {
    alert("Please keep at least one photo.");
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Ad →";
    generateBtn.style.background = "";
    return;
  }

  if (!reviewVehicle) {
    alert("No vehicle data found. Please go back and try again.");
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Ad →";
    generateBtn.style.background = "";
    return;
  }

  const videoType = document.getElementById("videoTypeSelect")?.value || "slideshow";

  const vehicle = {
    ...reviewVehicle,
    photos_for_video: allPhotos,
  };

  const theme = document.getElementById("themeSelect")?.value ||
    videoTypeSelectDash?.value || "family";

  // Send to background for video generation
  await chrome.runtime.sendMessage({
    type: "QUEUE_REVIEWED",
    vehicle: vehicle,
    video_type: videoType,
    theme: theme,
  });

  await chrome.storage.local.set({ current_generating_vin: reviewVehicle?.vin });

  // Remove this vehicle from the pending review queue
  const { pending_review_queue: rawQueue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const updatedQueue = rawQueue.filter(item => {
    if (reviewVehicle.vin && item.vehicle.vin) {
      return item.vehicle.vin !== reviewVehicle.vin;
    }
    return !(item.vehicle.model === reviewVehicle.model &&
      item.vehicle.year === reviewVehicle.year);
  });

  await chrome.storage.local.set({ pending_review_queue: updatedQueue });

  // Update badge
  chrome.action.setBadgeText({
    text: updatedQueue.length > 0 ? String(updatedQueue.length) : ""
  });

  // Go back to dashboard
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

// ── Facebook listing button ───────────────────────────────────

facebookBtn.addEventListener("click", async () => {
  console.log("OrbitAds: reviewPhotos state:", {
    exterior: reviewPhotos.exterior?.length,
    interior: reviewPhotos.interior?.length,
    additional: reviewPhotos.additional?.length,
  });
  facebookBtn.disabled = true;
  facebookBtn.textContent = "Generating listing...";

  try {
    const { token, pending_review } = await chrome.storage.local.get(["token", "pending_review"]);
    const v = reviewVehicle;
    if (!v) { alert("No vehicle data found."); return; }

    // Get reviewed photos from current reviewPhotos state
    // or fall back to pending_review.review_photos
    const sourcePhotos = (reviewPhotos.exterior?.length || reviewPhotos.interior?.length)
      ? reviewPhotos
      : pending_review?.review_photos;

    const reviewedPhotosList = [
      ...(sourcePhotos?.exterior || []),
      ...(sourcePhotos?.interior || []),
      ...(sourcePhotos?.additional || []),
    ];

    console.log("OrbitAds: Reviewed photos for FB:", reviewedPhotosList.length);

    const resp = await apiFetch(`${API_BASE}/listings/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim,
        price: v.price,
        mileage: v.mileage,
        vin: v.vin,
        dealership_name: v.dealership,
        listing_url: v.listing_url,
      }),
    });

    if (!resp.ok) throw new Error("Failed to generate listing");
    const listing = await resp.json();

    // Get video URL — check generation queue for this vehicle
    const { queue = [] } = await chrome.storage.local.get("queue");

    const completedJob = queue.find(j => {
      if (j.status !== "completed") return false;
      // Match by VIN first (most reliable)
      if (v.vin && j.vehicle?.vin && v.vin === j.vehicle.vin) return true;
      // Fallback: model + year + price (more specific than just model)
      return j.vehicle?.model === v.model &&
        j.vehicle?.year === v.year &&
        j.vehicle?.price === v.price;
    });

    const videoUrl = completedJob?.result_url || null;
    console.log("OrbitAds: Found completed job:", !!completedJob, "video_url:", videoUrl);

    await chrome.storage.local.set({
      fb_listing: {
        ...listing,
        vehicle: v,
        reviewed_photos: reviewedPhotosList,
        video_url: videoUrl,
        created_at: new Date().toISOString(),
      }
    });

    showFbListingScreen(listing, v);
    // Save to sold vehicle checker immediately
    chrome.runtime.sendMessage({
      type: "MARK_LISTING_POSTED",
      vehicle: v,
      listing_url: v.listing_url,
    });

  } catch (err) {
    console.error("Facebook listing error:", err);
    alert("Failed to generate listing. Please try again.");
  } finally {
    facebookBtn.disabled = false;
    facebookBtn.textContent = "📘 Post to Facebook";
  }
});

openFbBtn.addEventListener("click", async () => {
  if (!currentFbListing) return;

  // Get current reviewed photos
  const reviewedPhotosList = [
    ...(reviewPhotos.exterior || []),
    ...(reviewPhotos.interior || []),
    ...(reviewPhotos.additional || []),
  ];

  // Update fb_listing with reviewed photos before opening Facebook
  const { fb_listing } = await chrome.storage.local.get("fb_listing");
  if (fb_listing) {
    fb_listing.reviewed_photos = reviewedPhotosList.length > 0
      ? reviewedPhotosList
      : currentFbListing.listing.reviewed_photos || [];
    await chrome.storage.local.set({ fb_listing });
  }

  await chrome.runtime.sendMessage({
    type: "ADD_TO_FB_QUEUE",
    listing: { ...currentFbListing.listing, reviewed_photos: reviewedPhotosList },
    vehicle: currentFbListing.vehicle,
  });

  renderFbQueueStatus();
});

copyAllBtn.addEventListener("click", async () => {
  if (!currentFbListing) return;
  const { listing } = currentFbListing;
  const text = `TITLE: ${listing.title}\n\nPRICE: ${listing.price}\n\nDESCRIPTION:\n${listing.description}\n\nTAGS: ${(listing.tags || []).map(t => '#' + t).join(' ')}`;
  await navigator.clipboard.writeText(text);
  copyAllBtn.textContent = "✓ Copied!";
  setTimeout(() => { copyAllBtn.textContent = "📋 Copy All to Clipboard"; }, 2000);
});

async function renderFbQueueStatus() {
  const { fb_post_queue = [] } = await chrome.storage.local.get("fb_post_queue");
  if (fb_post_queue.length === 0) {
    fbPostingStatus.style.display = "none";
    return;
  }

  fbPostingStatus.style.display = "block";
  const active = fb_post_queue.filter(j => j.status !== "posted").length;
  fbStatusLabel.textContent = `${active} in posting queue`;

  fbQueueList.innerHTML = fb_post_queue.slice(-5).map(item => {
    const v = item.vehicle;
    const title = [v.year, v.make?.toUpperCase(), v.model].filter(Boolean).join(" ");
    const statusClass = `fb-queue-status-${item.status}`;
    const statusText = {
      waiting: "⏳ Waiting",
      posting: "📘 Opening...",
      posted: "✓ Posted",
      failed: "✕ Failed",
    }[item.status] || item.status;

    return `<div class="fb-queue-item">
      <span>${title}</span>
      <span class="${statusClass}">${statusText}</span>
    </div>`;
  }).join("");
}

document.getElementById("savePhotosBtn")?.addEventListener("click", async () => {
  await saveReviewPhotos();
  // Go back to dashboard
  showScreen(dashboardScreen);
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

// Upload handler
uploadInput.addEventListener("change", (e) => {
  Array.from(e.target.files).forEach(file => {
    const url = URL.createObjectURL(file);
    reviewPhotos.exterior.push(url);
  });
  renderPhotoSections();
});


// ── Start ──────────────────────────────────────────────────────
init();
startFbCountdown();


