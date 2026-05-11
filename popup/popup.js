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
const reviewScreen = document.getElementById("reviewScreen");
const reviewTitle = document.getElementById("reviewTitle");
const reviewMeta = document.getElementById("reviewMeta");
const reviewStatus = document.getElementById("reviewStatus");
const reviewSections = document.getElementById("reviewSections");
const generateBtn = document.getElementById("generateBtn");
const uploadInput = document.getElementById("uploadInput");
const facebookBtn = document.getElementById("facebookBtn");
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

// ── State ──────────────────────────────────────────────────────
let currentFbListing = null;
let queueInterval = null;
let reviewPhotos = { exterior: [], interior: [], other: [] };
let reviewVehicle = null;
let activeJobPolling = false;

// ... rest of the file (all functions and event listeners)
// ... init() call stays at the very bottom



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
  showScreen(queueScreen);
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

function showFbListingScreen(listing, vehicle) {
  currentFbListing = { listing, vehicle };

  // Header
  const title = [vehicle.year, vehicle.make?.toUpperCase(), vehicle.model, vehicle.trim]
    .filter(Boolean).join(" ");
  fbListingTitle.textContent = title || "Vehicle Listing";
  fbListingMeta.textContent = [
    vehicle.vin ? `VIN: ${vehicle.vin}` : null,
    vehicle.price,
    vehicle.mileage,
  ].filter(Boolean).join(" · ");

  // Fields
  fbTitleText.textContent = listing.title;
  fbPriceText.textContent = listing.price?.replace(/[^0-9]/g, "") || "";
  fbDescText.textContent = listing.description;

  // Tags
  fbTagsWrap.innerHTML = (listing.tags || [])
    .map(tag => `<span class="fb-tag">#${tag}</span>`)
    .join("");

  // Check posting queue status
  renderFbQueueStatus();

  showScreen(fbListingScreen);
}


// ── Screen management ─────────────────────────────────────────
function showScreen(screen) {
  [loginScreen, emptyScreen, queueScreen, reviewScreen, fbListingScreen]
    .forEach(s => s.style.display = "none");
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

  // Show sold vehicle notifications
  const { sold_notifications = [] } = await chrome.storage.local.get("sold_notifications");
  const soldBanner = document.getElementById("soldBanner");
  if (sold_notifications.length > 0 && soldBanner) {
    soldBanner.style.display = "flex";
    soldBanner.innerHTML = `
    <span>🚨 ${sold_notifications.length} vehicle${sold_notifications.length > 1 ? 's' : ''} may be sold — check your Facebook listings</span>
    <button class="btn-small" id="dismissSoldBtn">Dismiss</button>
  `;
    document.getElementById("dismissSoldBtn")?.addEventListener("click", async () => {
      await chrome.storage.local.remove("sold_notifications");
      chrome.action.setBadgeText({ text: "" });
      soldBanner.style.display = "none";
    });
  } else if (soldBanner) {
    soldBanner.style.display = "none";
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

  // Make job cards clickable — opens vehicle detail/review screen
  document.querySelectorAll(".job-card").forEach(card => {
    card.addEventListener("click", async (e) => {
      // Don't trigger if clicking View Ad link
      if (e.target.tagName === "A" || e.target.classList.contains("btn-small")) return;

      const jobId = card.dataset.jobId;
      const { queue = [] } = await chrome.storage.local.get("queue");
      const job = queue.find(j => j.id === jobId);
      if (!job) return;

      // Store this job as pending_review so review screen can show it
      const { pending_review } = await chrome.storage.local.get("pending_review");

      // Build a view-only pending_review from the job's vehicle data
      const photosForVideo = job.vehicle.photos_for_video || [];
      const allPhotos = job.vehicle.photos || [];

      // Photos that went into the video
      const videoPhotoSet = new Set(photosForVideo);

      // All remaining photos go to other
      const remainingPhotos = allPhotos.filter(url => !videoPhotoSet.has(url));

      const viewReview = {
        vehicle: job.vehicle,
        photos_all: allPhotos,
        view_only: true,
        completed_job: job,
        classified: {
          exterior: photosForVideo.slice(0, 6),
          interior: photosForVideo.slice(6, 8),
          additional: photosForVideo.slice(8),
          other: [],
        },
        review_photos: {
          exterior: photosForVideo.slice(0, 6),
          interior: photosForVideo.slice(6, 8),
          additional: photosForVideo.slice(8),
          other: remainingPhotos,   // all remaining photos shown here
        },
      };

      // If we have classified data saved in the job, use it
      if (job.vehicle.photos_for_video) {
        viewReview.review_photos = {
          exterior: job.vehicle.photos_for_video.slice(0, 6),
          interior: job.vehicle.photos_for_video.slice(6),
          additional: [],
          other: [],
        };
      }

      await chrome.storage.local.set({ pending_review: viewReview });
      showReviewScreen(viewReview);
    });
  });
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
    ? `<div class="job-actions">
         ${job.result_url
      ? `<a href="${job.result_url}" target="_blank" class="btn-small">▶ View Ad</a>`
      : `<span class="job-label" style="color:#6b7280">Fetching video link...</span>`
    }
       </div>`
    : job.status === "failed" && job.error
      ? `<div class="job-label" style="color:#dc2626;margin-top:4px">${job.error}</div>`
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

async function pollActiveJob() {
  if (activeJobPolling) return;  // already polling
  activeJobPolling = true;

  const activeJobInterval = setInterval(async () => {
    if (reviewScreen.style.display === "none") {
      clearInterval(activeJobInterval);
      activeJobPolling = false;
      return;
    }

    const { queue = [] } = await chrome.storage.local.get("queue");

    // Find the most recently added job (last in array)
    const latestJob = queue[queue.length - 1];

    const statusEl = document.getElementById("activeJobStatus");
    const labelEl = document.getElementById("activeJobLabel");
    const barEl = document.getElementById("activeJobBar");

    if (!latestJob || !statusEl) return;

    statusEl.style.display = "block";
    labelEl.textContent = latestJob.label || "Processing...";
    barEl.style.width = (latestJob.progress || 0) + "%";

    if (latestJob.status === "completed") {
      clearInterval(activeJobInterval);
      activeJobPolling = false;
      const completedRecently = latestJob.added_at &&
        (Date.now() - new Date(latestJob.added_at).getTime()) < 3600000;

      // Remove any previously added buttons in the status element
      statusEl.querySelectorAll("a").forEach(el => el.remove());

      if (latestJob.result_url && completedRecently) {
        labelEl.textContent = "✓ Ad ready!";
        barEl.classList.add("done");
        const viewBtn = document.createElement("a");
        viewBtn.href = latestJob.result_url;
        viewBtn.target = "_blank";
        viewBtn.className = "btn-small injected-view-btn";
        viewBtn.textContent = "▶ View Ad";
        viewBtn.style.marginTop = "8px";
        viewBtn.style.display = "inline-block";
        statusEl.appendChild(viewBtn);
      } else {
        statusEl.style.display = "none";
      }
    }

    if (latestJob.status === "failed") {
      clearInterval(activeJobInterval);
      activeJobPolling = false;
      labelEl.textContent = `Failed: ${latestJob.error || "Unknown error"}`;
      labelEl.style.color = "#dc2626";
      barEl.classList.add("failed");
    }
  }, 3000);
}

function showReviewScreen(pendingReview) {
  // Clean up any previously injected View Ad buttons
  document.querySelectorAll(".btn-primary[href], .injected-view-btn").forEach(el => el.remove());
  generateBtn.style.display = "block";

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
    document.getElementById("facebookBtn").disabled = false;
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

  if (pendingReview.view_only && pendingReview.review_photos) {
    // Populate reviewPhotos so facebookBtn can use it
    reviewPhotos = pendingReview.review_photos;
  }

  if (pendingReview.view_only && pendingReview.completed_job?.result_url) {
    generateBtn.style.display = "none";
    const viewBtn = document.createElement("a");
    viewBtn.href = pendingReview.completed_job.result_url;
    viewBtn.target = "_blank";
    viewBtn.className = "btn-primary injected-view-btn";
    viewBtn.textContent = "▶ View Ad";
    viewBtn.style.display = "block";
    viewBtn.style.textAlign = "center";
    viewBtn.style.textDecoration = "none";
    generateBtn.insertAdjacentElement("afterend", viewBtn);
  } else {
    generateBtn.style.display = "block";
    // Remove any previously added view buttons
    document.querySelectorAll(".btn-primary[href]").forEach(el => el.remove());
  }
  pollActiveJob();
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
      document.getElementById("facebookBtn").disabled = false;
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

  // Read selected video type
  const videoType = document.getElementById("videoTypeSelect")?.value || "walkaround";

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
    video_type: videoType,    // ← pass to background
  });

  await chrome.storage.local.remove("pending_review");
  chrome.action.setBadgeText({ text: "" });

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

    const resp = await fetch(`${API_BASE}/listings/generate`, {
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

    await chrome.storage.local.set({
      fb_listing: {
        ...listing,
        vehicle: v,
        reviewed_photos: reviewedPhotosList,
        created_at: new Date().toISOString(),
      }
    });

    showFbListingScreen(listing, v);

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
    ...(reviewPhotos.exterior   || []),
    ...(reviewPhotos.interior   || []),
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
    type:    "ADD_TO_FB_QUEUE",
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


