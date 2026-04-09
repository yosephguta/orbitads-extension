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
const loginScreen = document.getElementById("loginScreen");
const emptyScreen = document.getElementById("emptyScreen");
const queueScreen = document.getElementById("queueScreen");
const userInfo = document.getElementById("userInfo");
const userName = document.getElementById("userName");
const loginError = document.getElementById("loginError");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const jobList = document.getElementById("jobList");
const queueCount = document.getElementById("queueCount");
const backBtn = document.getElementById("backBtn");
let queueInterval = null;

backBtn.addEventListener("click", async () => {
  // Don't remove pending_review — just go back to queue
  // User can return to review by clicking the extension icon
  chrome.action.setBadgeText({ text: "!" });  // keep badge to remind them
  showScreen(queueScreen);
  renderQueue();
  if (queueInterval) clearInterval(queueInterval);
  queueInterval = setInterval(renderQueue, 2000);
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  const { token, user } = await chrome.storage.local.get(["token", "user"]);

  if (token && user) {
    showLoggedIn(user);
    // Check if there's a vehicle waiting for review
    const hasPendingReview = await checkPendingReview();
    if (!hasPendingReview) {
      renderQueue();
      if (queueInterval) clearInterval(queueInterval);
      queueInterval = setInterval(renderQueue, 2000);
    }
  } else {
    showScreen(loginScreen);
  }
}


// ── Screen management ─────────────────────────────────────────
function showScreen(screen) {
  [loginScreen, emptyScreen, queueScreen, reviewScreen].forEach(s => s.style.display = "none");
  screen.style.display = "block";
}

function showLoggedIn(user) {
  userInfo.style.display = "flex";
  userName.textContent = user.full_name?.split(" ")[0] || user.email;
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


// ── Queue rendering ───────────────────────────────────────────
async function renderQueue() {
  if (reviewScreen.style.display !== "none") return;
  const { queue = [], pending_review } = await chrome.storage.local.get(["queue", "pending_review"]);

  // Show resume banner if there's a pending review
  const resumeBanner = document.getElementById("resumeBanner");
  if (pending_review && resumeBanner) {
    const v = pending_review.vehicle;
    const title = [v.year, v.make?.toUpperCase(), v.model].filter(Boolean).join(" ");
    resumeBanner.style.display = "block";
    resumeBanner.innerHTML = `
      <span>📋 Review pending: ${title}</span>
      <button class="btn-small" id="resumeBtn">Resume →</button>
    `;
    document.getElementById("resumeBtn")?.addEventListener("click", () => {
      showReviewScreen(pending_review);
    });
  } else if (resumeBanner) {
    resumeBanner.style.display = "none";
  }

  if (queue.length === 0) {
    showScreen(emptyScreen);
    return;
  }

  showScreen(queueScreen);

  const waiting = queue.filter(j => j.status === "waiting").length;
  const generating = queue.filter(j => j.status === "generating").length;
  const completed = queue.filter(j => j.status === "completed").length;
  const failed = queue.filter(j => j.status === "failed").length;

  queueCount.textContent = `${queue.length} vehicle${queue.length !== 1 ? "s" : ""} — ` +
    [
      generating ? `${generating} generating` : "",
      waiting ? `${waiting} waiting` : "",
      completed ? `${completed} done` : "",
      failed ? `${failed} failed` : "",
    ].filter(Boolean).join(", ");

  jobList.innerHTML = [...queue].reverse().map(job => renderJobCard(job)).join("");
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

// ── Review screen ─────────────────────────────────────────────
const reviewScreen = document.getElementById("reviewScreen");
const reviewTitle = document.getElementById("reviewTitle");
const reviewMeta = document.getElementById("reviewMeta");
const reviewStatus = document.getElementById("reviewStatus");
const reviewSections = document.getElementById("reviewSections");
const generateBtn = document.getElementById("generateBtn");
const uploadInput = document.getElementById("uploadInput");

// Track user's selected photos for video
let reviewPhotos = { exterior: [], interior: [], other: [] };
let reviewVehicle = null;

async function checkPendingReview() {
  const { pending_review } = await chrome.storage.local.get("pending_review");
  if (pending_review) {
    showReviewScreen(pending_review);
    return true;
  }
  return false;
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

function showReviewScreen(pendingReview) {
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
    generateBtn.disabled = false;
    generateBtn.textContent = "Generate Ad →";
  }
  else {
    reviewStatus.textContent = "Classifying photos...";
    reviewStatus.style.display = "block";
    generateBtn.disabled = true;
    generateBtn.textContent = "Classifying...";
    // Poll until classification is done
    pollClassification();
  }

  showScreen(reviewScreen);
}

async function pollClassification() {
  const interval = setInterval(async () => {
    const { pending_review } = await chrome.storage.local.get("pending_review");
    if (pending_review?.classified) {
      clearInterval(interval);
      reviewStatus.style.display = "none";

      reviewPhotos = buildReviewPhotos(
        pending_review.classified,
        pending_review.photos_all || pending_review.vehicle.photos,
        pending_review.blocked_photos || [],
        pending_review.explicit_other || []
      );

      await saveReviewPhotos();  // save immediately so Back+Resume gets same result
      renderPhotoSections();
      updateFbBar();
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate Ad →";
    }
  }, 2000);
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

// Generate button
generateBtn.addEventListener("click", async () => {
  const allPhotos = [
    ...reviewPhotos.exterior,
    ...reviewPhotos.interior,
  ];

  if (allPhotos.length === 0) {
    alert("Please keep at least one photo.");
    return;
  }

  // Add to queue with reviewed photos
  const { pending_review } = await chrome.storage.local.get("pending_review");
  if (!pending_review) return;

  const vehicle = {
    ...pending_review.vehicle,
    photos: pending_review.vehicle.photos,
    photos_for_video: allPhotos,
  };

  await chrome.runtime.sendMessage({
    type: "QUEUE_REVIEWED",
    vehicle: vehicle,
  });

  // Clear pending review
  await chrome.storage.local.remove("pending_review");
  chrome.action.setBadgeText({ text: "" });

  // Show queue
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